"""PDF operations as pure functions over bytes.

Kept free of any web framework so the same code can back a CLI or other
front ends later.
"""

import json
import math
import re
import secrets
import zlib
from collections.abc import Sequence
from contextlib import ExitStack
from dataclasses import dataclass
from io import BytesIO
from typing import Literal

import img2pdf
import pikepdf
from PIL import Image, ImageChops, ImageDraw, ImageMath, ImageOps

from pdfer import fonts as fontlib

PageRange = tuple[int, int]
"""1-based, inclusive page range, e.g. (1, 3) is pages 1, 2 and 3."""


class PdfToolError(ValueError):
    """An error whose message is safe to show to the user."""


MAX_SIGNATURE_UPLOAD = 10 * 1024 * 1024


@dataclass(frozen=True)
class SignatureImage:
    data: bytes
    width: int
    height: int


def prepare_signature(data: bytes, *, remove_white: bool = False, trim: bool = True) -> SignatureImage:
    """Normalize a signature to a bounded PNG without source metadata."""
    if len(data) > MAX_SIGNATURE_UPLOAD:
        raise PdfToolError("Choose a signature image under 10 MB.")
    try:
        with Image.open(BytesIO(data)) as opened:
            if opened.format not in ("PNG", "JPEG"):
                raise PdfToolError("Import a PNG or JPEG signature image.")
            if opened.width * opened.height > 16_000_000:
                raise PdfToolError("Choose a signature image with at most 16 million pixels.")
            image = ImageOps.exif_transpose(opened).convert("RGBA")
    except PdfToolError:
        raise
    except Exception:
        raise PdfToolError("That signature image could not be read.") from None
    edge = 1584 if trim else 1600
    image.thumbnail((edge, edge), Image.Resampling.LANCZOS)
    if remove_white:
        red, green, blue, alpha = image.split()
        minimum = ImageChops.darker(ImageChops.darker(red, green), blue)
        denominator = minimum.point(lambda value: max(1, 255 - value))
        ink = minimum.point(lambda value: 0 if value >= 245 else 255 - value)
        # Remove the white contribution as well as changing alpha, keeping
        # antialiased ink the same apparent colour when placed on white paper.
        channels = [ImageMath.lambda_eval(lambda a: a["convert"]((a["c"] - a["m"]) * 255 / a["d"], "L"), c=c, m=minimum, d=denominator)
                    for c in (red, green, blue)]
        image = Image.merge("RGBA", (*channels, ImageChops.multiply(alpha, ink)))
    box = image.getchannel("A").getbbox()
    if box is None:
        raise PdfToolError("The signature is blank. Draw some ink or choose another image.")
    if trim:
        image = ImageOps.expand(image.crop(box), border=8, fill=(0, 0, 0, 0))
    image.info.clear()
    output = BytesIO()
    image.save(output, "PNG")
    encoded = output.getvalue()
    if len(encoded) > 5 * 1024 * 1024:
        raise PdfToolError("The signature image is too large. Crop it more before importing.")
    return SignatureImage(encoded, image.width, image.height)


def _open(data: bytes, name: str = "file", password: str = "") -> pikepdf.Pdf:
    try:
        return pikepdf.open(BytesIO(data), password=password)
    except pikepdf.PasswordError:
        if password:
            raise PdfToolError(f"The password for {name} is incorrect.") from None
        raise PdfToolError(f"{name} is password-protected.") from None
    except pikepdf.PdfError:
        raise PdfToolError(f"{name} isn't a valid PDF.") from None


def _encryption(password: str) -> pikepdf.Encryption | Literal[False]:
    # A separate, non-empty owner password prevents an empty-password bypass.
    return pikepdf.Encryption(user=password, owner=secrets.token_urlsafe(32), R=6) if password else False


def _save(pdf: pikepdf.Pdf, password: str = "", *, min_version: str = "1.3") -> bytes:
    out = BytesIO()
    pdf.save(out, encryption=_encryption(password), min_version=min_version)
    return out.getvalue()


def page_count(data: bytes, name: str = "file", password: str = "") -> int:
    with _open(data, name, password) as pdf:
        return len(pdf.pages)


def merge(files: Sequence[tuple[str, bytes]], passwords: Sequence[str] | None = None) -> bytes:
    """Concatenate PDFs, retaining the first protected input's opening password."""
    if len(files) < 2:
        raise PdfToolError("Choose at least two PDFs to merge.")

    passwords = [""] * len(files) if passwords is None else passwords
    if len(passwords) != len(files) or any(not isinstance(p, str) for p in passwords):
        raise PdfToolError("Provide one password per file, using an empty string for files without a password.")
    with ExitStack() as stack:
        sources = [stack.enter_context(_open(data, name, password)) for (name, data), password in zip(files, passwords)]
        output_password = next((password for src, password in zip(sources, passwords) if src.is_encrypted and password), "")
        with pikepdf.new() as merged:
            for src in sources:
                merged.pages.extend(src.pages)
            return _save(merged, output_password)


def protect(data: bytes, new_password: str, name: str = "file", password: str = "") -> bytes:
    """Add or replace the password needed to open a PDF, using AES-256."""
    if not new_password:
        raise PdfToolError("Enter a password for the protected copy.")
    if "\0" in new_password:
        raise PdfToolError("Passwords cannot contain a null character.")
    if len(new_password.encode("utf-8")) > 127:
        raise PdfToolError("Use a password of at most 127 UTF-8 bytes.")
    with _open(data, name, password) as pdf:
        return _save(pdf, new_password)


def unlock(data: bytes, name: str = "file", password: str = "") -> bytes:
    """Save an unencrypted copy after successfully opening the source PDF."""
    with _open(data, name, password) as pdf:
        return _save(pdf)


_RANGE_PART = re.compile(r"^(\d+)?\s*(-)?\s*(\d+)?$")


def parse_ranges(spec: str, total: int) -> list[PageRange]:
    """Parse a page spec like "1-3, 5, 8-" into ranges.

    "N-" runs to the last page and "-N" starts at page 1.
    """
    ranges: list[PageRange] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        m = _RANGE_PART.match(part)
        if not m or not (m[1] or m[3]):
            raise PdfToolError(f'"{part}" isn\'t a page or range like 2 or 4-7.')

        start_s, dash, end_s = m.groups()
        if dash:
            start = int(start_s) if start_s else 1
            end = int(end_s) if end_s else total
        else:
            start = end = int(start_s or end_s)

        if start < 1 or end > total:
            raise PdfToolError(f'"{part}" is outside pages 1-{total}.')
        if start > end:
            raise PdfToolError(f'"{part}" runs backwards.')
        ranges.append((start, end))

    if not ranges:
        raise PdfToolError("Enter at least one page or range.")
    return ranges


def _extract(src: pikepdf.Pdf, ranges: Sequence[PageRange], password: str = "") -> bytes:
    with pikepdf.new() as out:
        for start, end in ranges:
            out.pages.extend(src.pages[start - 1 : end])
        return _save(out, password if src.is_encrypted else "")


def split(data: bytes, ranges: Sequence[PageRange], name: str = "file", password: str = "") -> list[bytes]:
    """Return one PDF per range."""
    with _open(data, name, password) as src:
        return [_extract(src, [r], password) for r in ranges]


def extract(data: bytes, ranges: Sequence[PageRange], name: str = "file", password: str = "") -> bytes:
    """Return a single PDF containing all the ranges, in order."""
    with _open(data, name, password) as src:
        return _extract(src, ranges, password)


PageOp = tuple[int, int]
"""1-based page number and a clockwise rotation in degrees: 0, 90, 180 or 270."""

ROTATIONS = (0, 90, 180, 270)

_PAGE_OP = re.compile(r"^(\d+)\s*(?::\s*(\d+))?$")


def parse_page_ops(spec: str, total: int) -> list[PageOp]:
    """Parse a page list like "3:90, 1, 2:180" into (page, rotation) pairs.

    Each part is a page number, optionally followed by ":" and a clockwise
    rotation of 0, 90, 180 or 270 degrees. Pages may repeat; pages left out
    are dropped.
    """
    ops: list[PageOp] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        m = _PAGE_OP.match(part)
        if not m:
            raise PdfToolError(f'"{part}" isn\'t a page like 2 or 2:90.')

        page = int(m[1])
        rotation = int(m[2]) if m[2] else 0
        if not 1 <= page <= total:
            raise PdfToolError(f'"{part}" is outside pages 1-{total}.')
        if rotation not in ROTATIONS:
            raise PdfToolError(f'"{part}" needs a rotation of 0, 90, 180 or 270.')
        ops.append((page, rotation))

    if not ops:
        raise PdfToolError("Keep at least one page.")
    return ops


@dataclass(frozen=True)
class PageLayout:
    """Selected output positions, crop margins (top/right/bottom/left), and size, in points."""

    pages: frozenset[int]
    crop: tuple[float, float, float, float]
    resize: tuple[float, float] | None


def parse_page_layout(spec: str, total: int) -> PageLayout | None:
    """Optional Organize layout JSON. Public dimensions are in physical millimetres."""
    if not spec:
        return None
    try:
        value = json.loads(spec)
    except ValueError:
        raise PdfToolError("Crop and resize settings must be valid JSON.") from None
    if not isinstance(value, dict):
        raise PdfToolError("Crop and resize settings must be an object.")
    pages = value.get("pages")
    if not isinstance(pages, list) or not pages:
        raise PdfToolError("Select at least one page to crop or resize.")
    if any(type(p) is not int or not 1 <= p <= total for p in pages):
        raise PdfToolError(f"Crop and resize pages must be output positions from 1 to {total}.")

    def dimension(obj: dict, key: str, minimum: float) -> float:
        number = obj.get(key)
        if type(number) not in (int, float) or not minimum <= number <= 5080 or not math.isfinite(number):
            raise PdfToolError(f"{key.capitalize()} must be between {minimum:g} and 5080 mm.")
        return number * 72 / 25.4

    crop = value.get("crop")
    resize = value.get("resize")
    if crop is None and resize is None:
        raise PdfToolError("Enable cropping or resizing.")
    if crop is not None and not isinstance(crop, dict):
        raise PdfToolError("Crop margins must be an object.")
    if resize is not None and not isinstance(resize, dict):
        raise PdfToolError("Page size must be an object.")
    margins = tuple(dimension(crop, edge, 0) for edge in ("top", "right", "bottom", "left")) if crop is not None else (0., 0., 0., 0.)
    size = (dimension(resize, "width", 1), dimension(resize, "height", 1)) if resize is not None else None
    return PageLayout(frozenset(pages), margins, size)


def organize(data: bytes, ops: Sequence[PageOp], name: str = "file", password: str = "", *, layout: PageLayout | None = None) -> bytes:
    """Return a PDF with the given pages in order, each turned clockwise by its rotation.

    Rotations are relative to how the page is already displayed.
    """
    if not ops:
        raise PdfToolError("Keep at least one page.")

    with _open(data, name, password) as src:
        total = len(src.pages)
        for page, rotation in ops:
            if not 1 <= page <= total:
                raise PdfToolError(f"Page {page} is outside pages 1-{total}.")
            if rotation not in ROTATIONS:
                raise PdfToolError(f"{rotation} isn't a rotation of 0, 90, 180 or 270.")

        with pikepdf.new() as out:
            # Copy every page before rotating any: pikepdf clones a page that is
            # added a second time from its earlier copy, rotation included.
            out.add_pages_from(src, pages=[page - 1 for page, _ in ops])
            for position, (new_page, (_, rotation)) in enumerate(zip(out.pages, ops, strict=True), 1):
                if rotation:
                    new_page.rotate(rotation, relative=True)
                if layout is not None and position in layout.pages:
                    _layout_page(out, new_page, layout, position)
            return _save(out, password if src.is_encrypted else "")


def _layout_page(pdf: pikepdf.Pdf, page: pikepdf.Page, layout: PageLayout, position: int) -> None:
    frame, width, height = _display_frame(page)
    try:
        unit = float(page.get("/UserUnit", 1))
    except (TypeError, ValueError):
        unit = 1
    if not math.isfinite(unit) or unit <= 0:
        unit = 1
    top, right, bottom, left = (n / unit for n in layout.crop)
    if (width - left - right) * unit < 72 / 25.4 or (height - top - bottom) * unit < 72 / 25.4:
        raise PdfToolError(f"Crop margins leave less than 1 mm on output page {position}. Reduce the margins.")
    # Map the displayed rectangle back into the original page's coordinates.
    box = pikepdf.Matrix(*frame).transform(pikepdf.Rectangle(left, bottom, width - right, height - top))
    coordinates = [box.llx, box.lly, box.urx, box.ury]
    if any(layout.crop):
        page.CropBox = coordinates
    if layout.resize is None:
        return

    x0, y0, x1, y1 = coordinates
    target_width, target_height = (v / unit for v in layout.resize)
    if page.rotation in (90, 270):
        target_width, target_height = target_height, target_width
    scale = min(target_width / (x1 - x0), target_height / (y1 - y0))
    dx = (target_width - (x1 - x0) * scale) / 2 - x0 * scale
    dy = (target_height - (y1 - y0) * scale) / 2 - y0 * scale
    matrix = pikepdf.Matrix(scale, 0, 0, scale, dx, dy)

    # A form clips to the old visible area, so cropped content cannot reappear
    # in the padding around a resized page. Text and vectors stay intact.
    original = page.as_form_xobject(handle_transformations=False)
    # qpdf's form data provider reads the page lazily. Freeze its stream before
    # replacing Contents, otherwise the form can end up drawing itself.
    form = pdf.make_stream(original.read_bytes())
    for key, value in original.items():
        if key not in ("/Length", "/Filter", "/DecodeParms"):
            form[key] = value
    form.BBox = coordinates
    page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Content=form))
    page.Contents = pdf.make_stream(b"q " + matrix.encode() + b" cm /Content Do Q")
    page.MediaBox = [0, 0, target_width, target_height]
    page.CropBox = [0, 0, target_width, target_height]
    for key in ("/TrimBox", "/BleedBox", "/ArtBox"):
        if key in page.obj:
            del page.obj[key]

    if "/Annots" in page.obj:
        _resize_annotations(pdf, page, matrix, scale, box)


def _resize_annotations(pdf: pikepdf.Pdf, page: pikepdf.Page, matrix: pikepdf.Matrix, scale: float, crop: pikepdf.Rectangle) -> None:
    """Scale appearance streams and geometry without detaching registered form fields."""
    old = list(page.Annots)
    transformed, _, _ = pdf.acroform.transform_annotations(page.Annots, matrix)
    annotations = []
    for source, changed in zip(old, transformed, strict=True):
        rect = _box(source.get("/Rect"))
        # Form fields already belong to the copied document's field tree. Keep
        # that identity; qpdf's transformed clone supplies geometry/appearance.
        target = source if source.get("/Subtype") == pikepdf.Name.Widget else changed
        for key in ("/Rect", "/AP"):
            if key in changed:
                target[key] = changed[key]
        target.P = page.obj
        for key in ("/QuadPoints", "/Vertices", "/L", "/CL"):
            if key in source:
                points = list(source[key])
                target[key] = [v for i in range(0, len(points) - 1, 2) for v in matrix.transform((float(points[i]), float(points[i + 1])))]
        if "/InkList" in source:
            target.InkList = [[v for i in range(0, len(stroke) - 1, 2) for v in matrix.transform((float(stroke[i]), float(stroke[i + 1])))] for stroke in source.InkList]
        if "/RD" in source:
            target.RD = [float(v) * scale for v in source.RD]
        # An annotation outside the retained crop must not appear in new padding.
        if rect and (rect[2] <= crop.llx or rect[0] >= crop.urx or rect[3] <= crop.lly or rect[1] >= crop.ury):
            target.F = int(target.get("/F", 0)) | 2
        annotations.append(target)
    page.Annots = pikepdf.Array(annotations)


CompressLevel = Literal["light", "balanced", "strong"]

_IMAGE_LIMITS: dict[str, tuple[int, int]] = {
    # level: (longest side in px, JPEG quality)
    "balanced": (1600, 75),
    "strong": (1000, 60),
}


def compress(data: bytes, level: CompressLevel, name: str = "file", password: str = "") -> bytes:
    """Return a smaller copy of the PDF, or the original bytes if nothing shrank.

    Every level drops unused resources and rewrites the file with object
    streams and recompressed Flate streams, which keeps text and vectors
    exactly as they were. "balanced" and "strong" also re-encode raster
    images as JPEG, downscaled so the longer side is at most 1600 px or
    1000 px.
    """
    if level not in ("light", "balanced", "strong"):
        raise PdfToolError(f"{level!r} isn't a compression level: light, balanced or strong.")

    with _open(data, name, password) as pdf:
        if level in _IMAGE_LIMITS:
            max_side, quality = _IMAGE_LIMITS[level]
            _recompress_images(pdf, max_side, quality)
        pdf.remove_unreferenced_resources()
        out = BytesIO()
        pdf.save(
            out,
            object_stream_mode=pikepdf.ObjectStreamMode.generate,
            compress_streams=True,
            recompress_flate=True,
            encryption=_encryption(password) if pdf.is_encrypted else False,
        )
        result = out.getvalue()

    return result if len(result) < len(data) else data


def _recompress_images(pdf: pikepdf.Pdf, max_side: int, quality: int) -> None:
    """Re-encode the raster images on every page in place.

    Images inside form XObjects are handled too, however deeply nested.
    Inline images (``BI ... EI`` in a content stream) and pattern or
    annotation appearance images are left alone.
    """
    seen: set[tuple[int, int]] = set()
    for page in pdf.pages:
        _recompress_xobjects(page.obj, max_side, quality, seen)


def _recompress_xobjects(
    container: pikepdf.Object, max_side: int, quality: int, seen: set[tuple[int, int]]
) -> None:
    """Walk the XObjects of a page or form, recursing into nested forms."""
    resources = container.get("/Resources")
    xobjects = resources.get("/XObject") if isinstance(resources, pikepdf.Dictionary) else None
    if not isinstance(xobjects, pikepdf.Dictionary):
        return

    for _, obj in xobjects.items():
        if not isinstance(obj, pikepdf.Stream):
            continue
        # The same image (or form) can be shared between pages, and forms can
        # even reference each other, so visit each indirect object only once.
        objgen = obj.objgen
        if objgen[0] != 0:
            if objgen in seen:
                continue
            seen.add(objgen)

        subtype = obj.get("/Subtype")
        if subtype == pikepdf.Name.Form:
            _recompress_xobjects(obj, max_side, quality, seen)
        elif subtype == pikepdf.Name.Image:
            _recompress_image(obj, max_side, quality)


def _recompress_image(obj: pikepdf.Stream, max_side: int, quality: int) -> None:
    """Replace one image stream with a downscaled JPEG when that is smaller."""
    # Soft masks and colour-key masks would be lost or misaligned by a
    # resize, and stencil masks, palettes and CMYK don't map onto a plain
    # 8-bit JPEG without changing how the page looks.
    if "/SMask" in obj or "/Mask" in obj:
        return
    try:
        image = pikepdf.PdfImage(obj)
        if image.image_mask or image.indexed or image.bits_per_component != 8 or image.mode == "CMYK":
            return
        pil = image.as_pil_image()
    except Exception:  # noqa: BLE001 - JPX, exotic colour spaces, corrupt data: keep the original
        return

    pil = pil.convert("L" if pil.mode in ("L", "LA", "1", "I", "I;16") else "RGB")
    width, height = pil.size
    scale = max_side / max(width, height)
    if scale < 1:
        pil = pil.resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.Resampling.LANCZOS)

    buf = BytesIO()
    pil.save(buf, format="JPEG", quality=quality, optimize=True)
    jpeg = buf.getvalue()
    if len(jpeg) >= len(obj.read_raw_bytes()):
        return

    obj.write(jpeg, filter=pikepdf.Name.DCTDecode)
    obj.Width = pil.width
    obj.Height = pil.height
    obj.ColorSpace = pikepdf.Name.DeviceGray if pil.mode == "L" else pikepdf.Name.DeviceRGB
    obj.BitsPerComponent = 8
    # /Decode was already applied while decoding, and the old /DecodeParms
    # described the filter we just replaced.
    for key in ("/DecodeParms", "/Decode"):
        if key in obj:
            del obj[key]


_IMAGE_ERRORS = (
    img2pdf.JpegColorspaceError,
    img2pdf.UnsupportedColorspaceError,
    img2pdf.NegativeDimensionError,
    img2pdf.PdfTooLargeError,
    img2pdf.ExifOrientationError,
)


def _image_page(name: str, data: bytes, *, square_pixels: bool = False) -> bytes:
    """A one-page PDF holding the image as it is, honouring EXIF orientation."""
    try:
        converted = img2pdf.convert(
            # The internal writer accepts tiny source pages, which are later
            # placed on paper; pikepdf's blank-page helper rejects edges < 3 pt.
            data, engine=img2pdf.Engine.internal, rotation=img2pdf.Rotation.ifvalid, first_frame_only=True,
            layout_fun=img2pdf.get_fixed_dpi_layout_fun((72, 72)) if square_pixels else img2pdf.default_layout_fun,
        )
    except img2pdf.ImageOpenError:
        raise PdfToolError(f"{name} isn't an image pdfer can read.") from None
    except _IMAGE_ERRORS:
        raise PdfToolError(f"{name} can't be put in a PDF.") from None

    # img2pdf handles rotations, but ignores mirrored EXIF orientations. Apply
    # those as PDF transforms so even mirrored JPEGs need no recompression.
    try:
        with Image.open(BytesIO(data)) as image:
            orientation = image.getexif().get(0x0112, 1)
    except (OSError, ValueError, TypeError):
        orientation = 1
    if orientation not in (2, 4, 5, 7):
        return converted
    with pikepdf.open(BytesIO(converted)) as pdf:
        page = pdf.pages[0]
        width, height = float(page.mediabox[2]), float(page.mediabox[3])
        matrix = {
            2: (-1, 0, 0, 1, width, 0),
            4: (1, 0, 0, -1, 0, height),
            5: (0, -1, -1, 0, height, width),
            7: (0, 1, 1, 0, 0, 0),
        }[orientation]
        page.contents_add(b"q\n" + pikepdf.unparse_content_stream([(list(matrix), pikepdf.Operator("cm"))]) + b"\n", prepend=True)
        page.contents_add(b"Q\n")
        if orientation in (5, 7):
            page.MediaBox = [0, 0, height, width]
        return _save(pdf)


@dataclass(frozen=True)
class ImagePdfLayout:
    paper: Literal["image", "a4", "letter"] = "image"
    orientation: Literal["portrait", "landscape"] = "portrait"
    margin_mm: float = 10
    fit: Literal["contain", "cover", "stretch"] = "contain"


IMAGE_PAPER_MM = {"a4": (210, 297), "letter": (215.9, 279.4)}


def validate_image_layout(layout: ImagePdfLayout) -> None:
    if layout.paper not in ("image", "a4", "letter"):
        raise PdfToolError("Choose Image size, A4 or Letter paper.")
    if layout.orientation not in ("portrait", "landscape"):
        raise PdfToolError("Choose portrait or landscape orientation.")
    if layout.fit not in ("contain", "cover", "stretch"):
        raise PdfToolError("Choose fit, fill and crop, or stretch for image fitting.")
    if isinstance(layout.margin_mm, bool) or not isinstance(layout.margin_mm, (int, float)) or not math.isfinite(layout.margin_mm) or not 0 <= layout.margin_mm <= 100:
        raise PdfToolError("Margins must be from 0 to 100 mm.")


def image_page_size(layout: ImagePdfLayout) -> tuple[float, float]:
    width, height = (value * 72 / 25.4 for value in IMAGE_PAPER_MM[layout.paper])
    return (height, width) if layout.orientation == "landscape" else (width, height)


def _place_image(width: float, height: float, page_width: float, page_height: float, margin: float, fit: str) -> tuple[float, float, float, float]:
    """Centered image rectangle in PDF points, possibly larger than its clipped area."""
    area_width, area_height = page_width - 2 * margin, page_height - 2 * margin
    if area_width <= 0 or area_height <= 0:
        raise PdfToolError("The margins leave no room for an image. Reduce the margins.")
    if fit == "stretch":
        draw_width, draw_height = area_width, area_height
    else:
        scale = (max if fit == "cover" else min)(area_width / width, area_height / height)
        draw_width, draw_height = width * scale, height * scale
    return (page_width - draw_width) / 2, (page_height - draw_height) / 2, draw_width, draw_height


def _image_on_paper(out: pikepdf.Pdf, source: pikepdf.Page, layout: ImagePdfLayout) -> None:
    """Place the oriented image as a form, preserving its encoded pixels and alpha."""
    width, height = image_page_size(layout)
    margin = layout.margin_mm * 72 / 25.4
    form = source.as_form_xobject()
    matrix = pikepdf.Matrix(*(float(value) for value in form.get("/Matrix", [1, 0, 0, 1, 0, 0])))
    bounds = matrix.transform(pikepdf.Rectangle(form.BBox))
    x, y, draw_width, draw_height = _place_image(bounds.width, bounds.height, width, height, margin, layout.fit)
    scale_x, scale_y = draw_width / bounds.width, draw_height / bounds.height
    page = out.add_blank_page(page_size=(width, height))
    name = page.add_resource(out.copy_foreign(form), pikepdf.Name.XObject, prefix="Im")
    # The clipping rectangle stays in page coordinates. In fill mode this
    # crops the image at the margins, rather than allowing it to cover them.
    instructions = [
        ([], pikepdf.Operator("q")),
        ([1, 1, 1], pikepdf.Operator("rg")),
        ([0, 0, width, height], pikepdf.Operator("re")), ([], pikepdf.Operator("f")),
        ([margin, margin, width - 2 * margin, height - 2 * margin], pikepdf.Operator("re")),
        ([], pikepdf.Operator("W")), ([], pikepdf.Operator("n")),
        ([scale_x, 0, 0, scale_y, x - bounds.llx * scale_x, y - bounds.lly * scale_y], pikepdf.Operator("cm")),
        ([name], pikepdf.Operator("Do")), ([], pikepdf.Operator("Q")),
    ]
    page.Contents = out.make_stream(pikepdf.unparse_content_stream(instructions))


def images_to_pdf(files: Sequence[tuple[str, bytes]], layout: ImagePdfLayout | None = None) -> bytes:
    """Put each image on its own page, in order. Each item is (display name, bytes).

    JPEGs and PNGs are embedded without re-encoding. With no layout, pages
    take the image's size at its own resolution, or 96 dpi when unspecified.
    A4/Letter layouts use the oriented pixel aspect ratio, independently of DPI.
    """
    if not files:
        raise PdfToolError("Choose at least one image.")

    layout = layout or ImagePdfLayout()
    validate_image_layout(layout)
    with pikepdf.new() as out:
        for name, data in files:
            page = _image_page(name, data, square_pixels=layout.paper != "image")
            with pikepdf.open(BytesIO(page)) as src:
                if layout.paper == "image":
                    out.pages.extend(src.pages)
                else:
                    _image_on_paper(out, src.pages[0], layout)
        return _save(out, min_version="1.4")


# --- Edit: stamp text, images and shapes onto pages -------------------------
#
# Positions and sizes are in points on the page as a viewer shows it: the
# origin is the top-left corner, x runs right and y runs down, after the
# page's own /Rotate and crop box are applied. That is the frame pdf.js draws
# in, so the frontend can send what it shows without knowing about either.

Color = tuple[float, float, float]
"""Red, green and blue, each from 0 to 1."""

Point = tuple[float, float]

FontFamily = fontlib.FontFamily

TEXT_ASCENT = 0.9
"""Distance from the top of a text box to its first baseline, as a fraction of the font size."""

TEXT_LINE_HEIGHT = 1.2
"""Distance between baselines, as a fraction of the font size."""


@dataclass(frozen=True, kw_only=True)
class _Edit:
    page: int
    """1-based page number."""


@dataclass(frozen=True, kw_only=True)
class TextEdit(_Edit):
    """Lines of text whose box has its top-left corner at (x, y)."""

    x: float
    y: float
    text: str
    size: float
    color: Color
    family: FontFamily = "sans"
    bold: bool = False
    italic: bool = False


@dataclass(frozen=True, kw_only=True)
class _TextStamp(_Edit):
    """A single embedded-font line, rotated about its centre in display coordinates."""

    x: float
    y: float
    width: float
    height: float
    text: str
    size: float
    color: Color
    family: FontFamily
    opacity: float
    rotation: float


@dataclass(frozen=True, kw_only=True)
class ImageEdit(_Edit):
    x: float
    y: float
    width: float
    height: float
    image: int
    """Index into the images handed to edit()."""


@dataclass(frozen=True, kw_only=True)
class RegionEdit(_Edit):
    """Move, copy or visually delete original content, in physical display points.

    The source is covered with white, not securely removed. The destination
    uses a clipped form XObject, so text and vector graphics remain sharp.
    Deleted regions keep only the source mask, with no destination cutout.
    Copies place a cutout without covering the source.
    """

    source: tuple[float, float, float, float]  # left, top, width, height
    x: float
    y: float
    width: float
    height: float
    source_page: int | None = None
    rotation: int = 0  # clockwise; width/height are the rotated visible box
    copy: bool = False
    deleted: bool = False

    @property
    def origin_page(self) -> int:
        # Older clients used page for both ends of a same-page move.
        return self.page if self.source_page is None else self.source_page


@dataclass(frozen=True, kw_only=True)
class ShapeEdit(_Edit):
    shape: Literal["rect", "ellipse"]
    x: float
    y: float
    width: float
    height: float
    stroke: Color | None
    stroke_width: float
    fill: Color | None


@dataclass(frozen=True, kw_only=True)
class HighlightEdit(_Edit):
    """A translucent-looking box that darkens what is under it, like a marker pen."""

    x: float
    y: float
    width: float
    height: float
    color: Color


@dataclass(frozen=True, kw_only=True)
class LineEdit(_Edit):
    x1: float
    y1: float
    x2: float
    y2: float
    stroke: Color
    stroke_width: float


@dataclass(frozen=True, kw_only=True)
class DrawEdit(_Edit):
    """A freehand stroke through the points, in order. One point draws a dot."""

    points: tuple[Point, ...]
    stroke: Color
    stroke_width: float


Edit = TextEdit | ImageEdit | RegionEdit | ShapeEdit | HighlightEdit | LineEdit | DrawEdit | _TextStamp

_MAX_COORD = 100_000
_MAX_TEXT = 5_000
_MAX_POINTS = 10_000
_COLOR = re.compile(r"^#([0-9a-fA-F]{6})$")


class _Fields:
    """Reads one edit's fields out of parsed JSON, with errors the user can act on."""

    def __init__(self, item: object, label: str):
        if not isinstance(item, dict):
            raise PdfToolError(f"{label} isn't an object.")
        self.item = item
        self.label = label

    def _raw(self, key: str) -> object:
        if key not in self.item:
            raise PdfToolError(f'{self.label} is missing "{key}".')
        return self.item[key]

    def num(self, key: str, low: float = -_MAX_COORD, high: float = _MAX_COORD) -> float:
        v = self._raw(key)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not low <= v <= high:
            raise PdfToolError(f'{self.label}: "{key}" must be a number from {low:g} to {high:g}.')
        return float(v)

    def length(self, key: str, high: float = _MAX_COORD) -> float:
        v = self.num(key, 0, high)
        if v <= 0:
            raise PdfToolError(f'{self.label}: "{key}" must be more than 0.')
        return v

    def page(self, total: int, key: str = "page") -> int:
        v = self.item.get(key)
        if isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= total:
            raise PdfToolError(f'{self.label}: "{key}" is outside pages 1-{total}.')
        return v

    def text(self, key: str, max_len: int) -> str:
        v = self._raw(key)
        if not isinstance(v, str):
            raise PdfToolError(f'{self.label}: "{key}" must be text.')
        if len(v) > max_len:
            raise PdfToolError(f'{self.label}: "{key}" is longer than {max_len} characters.')
        return v

    def flag(self, key: str) -> bool:
        v = self.item.get(key, False)
        if not isinstance(v, bool):
            raise PdfToolError(f'{self.label}: "{key}" must be true or false.')
        return v

    def choice[T: str](self, key: str, options: Sequence[T]) -> T:
        v = self._raw(key)
        if v not in options:
            raise PdfToolError(f'{self.label}: "{key}" must be one of {", ".join(options)}.')
        return v  # type: ignore[return-value]

    def color(self, key: str, *, optional: bool = False) -> Color | None:
        v = self.item.get(key) if optional else self._raw(key)
        if v is None and optional:
            return None
        m = _COLOR.match(v) if isinstance(v, str) else None
        if not m:
            raise PdfToolError(f'{self.label}: "{key}" must be a colour like #ff8800.')
        hexes = m[1]
        return tuple(int(hexes[i : i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]

    def points(self, key: str) -> tuple[Point, ...]:
        v = self._raw(key)
        ok = (
            isinstance(v, list)
            and 0 < len(v) <= _MAX_POINTS
            and all(
                isinstance(p, list)
                and len(p) == 2
                and all(
                    not isinstance(c, bool) and isinstance(c, (int, float)) and abs(c) <= _MAX_COORD for c in p
                )
                for p in v
            )
        )
        if not ok:
            raise PdfToolError(f'{self.label}: "{key}" must be a list of [x, y] pairs.')
        return tuple((float(p[0]), float(p[1])) for p in v)


_KINDS = ("text", "image", "region", "rect", "ellipse", "highlight", "line", "draw")


def _region_rotation(value: object) -> int:
    if isinstance(value, bool) or value not in (0, 90, 180, 270):
        raise PdfToolError("Region rotation must be 0, 90, 180 or 270 degrees.")
    return int(value)  # type: ignore[arg-type]


def parse_edits(spec: str, total: int, images: int = 0) -> list[Edit]:
    """Parse a JSON list of edits.

    Every item has a "type" and a 1-based "page". The other fields match the
    dataclasses above, with camelCase keys: "strokeWidth", and colours as
    "#rrggbb". An image edit names its picture by "image", an index into the
    `images` that will be handed to edit(); the count is checked here.
    """
    try:
        items = json.loads(spec)
    except ValueError:
        raise PdfToolError("The edits aren't valid JSON.") from None
    if not isinstance(items, list):
        raise PdfToolError("The edits must be a list.")
    if not items:
        raise PdfToolError("Add at least one edit.")

    edits: list[Edit] = []
    for i, item in enumerate(items, 1):
        f = _Fields(item, f"Edit {i}")
        kind = f.choice("type", _KINDS)
        page = f.page(total)
        if kind == "text":
            edits.append(
                TextEdit(
                    page=page,
                    x=f.num("x"),
                    y=f.num("y"),
                    text=f.text("text", _MAX_TEXT),
                    size=f.num("size", 1, 1000),
                    color=f.color("color"),  # type: ignore[arg-type]
                    family=f.choice("family", ("sans", "serif", "mono")) if "family" in f.item else "sans",
                    bold=f.flag("bold"),
                    italic=f.flag("italic"),
                )
            )
        elif kind == "image":
            index = f.item.get("image")
            if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < images:
                raise PdfToolError(f"{f.label} refers to an image that wasn't uploaded.")
            edits.append(
                ImageEdit(
                    page=page, x=f.num("x"), y=f.num("y"), width=f.length("width"), height=f.length("height"), image=index
                )
            )
        elif kind == "region":
            source = _Fields(f._raw("source"), f"{f.label} source")
            edits.append(RegionEdit(
                page=page,
                source_page=f.page(total, "sourcePage") if "sourcePage" in f.item else page,
                rotation=_region_rotation(f.item.get("rotation", 0)),
                copy=f.flag("copy"),
                deleted=f.flag("deleted"),
                source=(source.num("x", 0), source.num("y", 0), source.num("width", 2), source.num("height", 2)),
                x=f.num("x", 0), y=f.num("y", 0), width=f.num("width", 2), height=f.num("height", 2),
            ))
        elif kind in ("rect", "ellipse"):
            stroke = f.color("stroke", optional=True)
            fill = f.color("fill", optional=True)
            if stroke is None and fill is None:
                raise PdfToolError(f"{f.label} needs a stroke or a fill.")
            edits.append(
                ShapeEdit(
                    page=page,
                    shape=kind,  # type: ignore[arg-type]
                    x=f.num("x"),
                    y=f.num("y"),
                    width=f.length("width"),
                    height=f.length("height"),
                    stroke=stroke,
                    stroke_width=f.num("strokeWidth", 0, 1000) if stroke else 0,
                    fill=fill,
                )
            )
        elif kind == "highlight":
            edits.append(
                HighlightEdit(
                    page=page,
                    x=f.num("x"),
                    y=f.num("y"),
                    width=f.length("width"),
                    height=f.length("height"),
                    color=f.color("color"),  # type: ignore[arg-type]
                )
            )
        elif kind == "line":
            edits.append(
                LineEdit(
                    page=page,
                    x1=f.num("x1"),
                    y1=f.num("y1"),
                    x2=f.num("x2"),
                    y2=f.num("y2"),
                    stroke=f.color("stroke"),  # type: ignore[arg-type]
                    stroke_width=f.length("strokeWidth", 1000),
                )
            )
        else:
            edits.append(
                DrawEdit(
                    page=page,
                    points=f.points("points"),
                    stroke=f.color("stroke"),  # type: ignore[arg-type]
                    stroke_width=f.length("strokeWidth", 1000),
                )
            )
    return edits


def edit(data: bytes, edits: Sequence[Edit], images: Sequence[tuple[str, bytes]] = (), name: str = "file", password: str = "") -> bytes:
    """Draw edits and move regions. Each image is (display name, bytes).

    Regions always sample the original page, before any edits. All vacated
    areas are covered first, then edits are drawn in their listed order.
    """
    if not edits:
        raise PdfToolError("Add at least one edit.")
    if sum(isinstance(e, RegionEdit) for e in edits) > 200:
        raise PdfToolError("Use at most 200 regions at a time.")

    with _open(data, name, password) as pdf:
        total = len(pdf.pages)
        by_page: dict[int, list[Edit]] = {}
        by_source: dict[int, list[RegionEdit]] = {}
        for e in edits:
            if not 1 <= e.page <= total:
                raise PdfToolError(f"Page {e.page} is outside pages 1-{total}.")
            if isinstance(e, ImageEdit) and not 0 <= e.image < len(images):
                raise PdfToolError("An edit refers to an image that wasn't provided.")
            if isinstance(e, RegionEdit):
                _region_rotation(e.rotation)
                if e.copy and e.deleted:
                    raise PdfToolError("To delete a copied region, remove its edit instead of marking its source deleted.")
                if isinstance(e.origin_page, bool) or not isinstance(e.origin_page, int) or not 1 <= e.origin_page <= total:
                    raise PdfToolError(f"Source page {e.origin_page} is outside pages 1-{total}.")
                by_source.setdefault(e.origin_page, []).append(e)
                if e.deleted:
                    continue  # Keep only the source mask; the destination is untouched.
            by_page.setdefault(e.page, []).append(e)

        painter = _Painter(pdf, images)
        for page_no, regions in by_source.items():
            _region_boxes(pdf.pages[page_no - 1], regions, source=True)
        for page_no, page_edits in by_page.items():
            _region_boxes(pdf.pages[page_no - 1], [e for e in page_edits if isinstance(e, RegionEdit)], source=False)
        # Capture every source before painting any page, including when two
        # pages exchange regions or a source page also has ordinary overlays.
        painter.region_sources = {
            number: _region_original(pdf, pdf.pages[number - 1])
            for number, regions in by_source.items() if any(not region.deleted for region in regions)
        }
        vacated = {number: [region for region in regions if not region.copy] for number, regions in by_source.items()}
        for page_no in dict.fromkeys([*by_page, *(number for number, regions in vacated.items() if regions)]):
            painter.paint(pdf.pages[page_no - 1], by_page.get(page_no, []), vacated=vacated.get(page_no, []))
        painter.finish()
        return _save(pdf, password if pdf.is_encrypted else "", min_version="1.4" if images else "1.3")


Box = tuple[float, float, float, float]
"""x0, y0, x1, y1 with x0 <= x1 and y0 <= y1."""

_LETTER: Box = (0, 0, 612, 792)


def _box(obj: object) -> Box | None:
    try:
        x0, y0, x1, y1 = (float(v) for v in obj)  # type: ignore[union-attr]
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (x0, y0, x1, y1)):
        return None
    return min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)


def _display_frame(page: pikepdf.Page) -> tuple[tuple[float, ...], float, float]:
    """How a viewer shows the page: a matrix and the displayed width and height.

    The matrix maps the "display frame" into the page's user space. The frame
    has its origin at the bottom-left corner of the page as displayed, x to
    the right and y up, in points, so content drawn in it is seen upright
    whatever the page's /Rotate. Like pdf.js, the visible area is the crop
    box clipped to the media box, or the media box when that is empty.
    """
    media = _box(page.mediabox) or _LETTER
    if media[2] - media[0] <= 0 or media[3] - media[1] <= 0:
        media = _LETTER
    crop = _box(page.cropbox) or media
    box = (max(crop[0], media[0]), max(crop[1], media[1]), min(crop[2], media[2]), min(crop[3], media[3]))
    if box[2] - box[0] <= 0 or box[3] - box[1] <= 0:
        box = media
    x0, y0, x1, y1 = box
    width, height = x1 - x0, y1 - y0

    rotation = page.rotation
    if rotation == 90:
        return (0, 1, -1, 0, x1, y0), height, width
    if rotation == 180:
        return (-1, 0, 0, -1, x1, y1), width, height
    if rotation == 270:
        return (0, -1, 1, 0, x0, y1), height, width
    return (1, 0, 0, 1, x0, y0), width, height


# --- Page numbers and text watermarks ----------------------------------------

STAMP_POSITIONS = (
    "top-left", "top-center", "top-right",
    "middle-left", "center", "middle-right",
    "bottom-left", "bottom-center", "bottom-right",
)
NUMBER_POSITIONS = tuple(p for p in STAMP_POSITIONS if p.startswith(("top-", "bottom-")))


@dataclass(frozen=True, kw_only=True)
class StampStyle:
    position: str
    margin: float
    size: float
    color: Color
    family: FontFamily


@dataclass(frozen=True, kw_only=True)
class PageNumbers(StampStyle):
    start: int
    mode: Literal["document", "selected"]
    format: Literal["number", "page", "of-total", "page-of-total"]


@dataclass(frozen=True, kw_only=True)
class Watermark(StampStyle):
    text: str
    opacity: float
    rotation: float


@dataclass(frozen=True)
class StampOptions:
    pages: tuple[int, ...]
    numbers: PageNumbers | None
    watermark: Watermark | None


def parse_stamps(spec: str, total: int) -> StampOptions:
    try:
        raw = json.loads(spec)
    except ValueError:
        raise PdfToolError("The stamp settings aren't valid JSON.") from None
    fields = _Fields(raw, "Stamp settings")
    ranges = parse_ranges(fields.text("pages", 5000), total)
    pages = tuple(sorted({page for start, end in ranges for page in range(start, end + 1)}))

    def style(f: _Fields, positions: Sequence[str], max_size: int) -> dict[str, object]:
        return {
            "position": f.choice("position", positions),
            "margin": f.num("margin", 0, 144),
            "size": f.num("size", 6, max_size),
            "color": f.color("color"),
            "family": f.choice("family", fontlib.FAMILIES),
        }

    numbers = None
    if fields.item.get("numbers") is not None:
        f = _Fields(fields.item["numbers"], "Page numbers")
        start = f.num("start", 1, 1_000_000)
        if not start.is_integer():
            raise PdfToolError("The starting page number must be a whole number.")
        numbers = PageNumbers(
            **style(f, NUMBER_POSITIONS, 72), start=int(start),
            mode=f.choice("mode", ("document", "selected")),
            format=f.choice("format", ("number", "page", "of-total", "page-of-total")),
        )
    watermark = None
    if fields.item.get("watermark") is not None:
        f = _Fields(fields.item["watermark"], "Watermark")
        text = f.text("text", 200)
        if not text.strip():
            raise PdfToolError("Enter some watermark text.")
        if len(_text_lines(text)) != 1:
            raise PdfToolError("Use a single line for the watermark.")
        watermark = Watermark(
            **style(f, STAMP_POSITIONS, 200), text=text,
            opacity=f.num("opacity", 0.01, 1), rotation=f.num("rotation", -180, 180),
        )
    if numbers is None and watermark is None:
        raise PdfToolError("Enable page numbers, a watermark, or both.")
    return StampOptions(pages, numbers, watermark)


def page_number_text(style: PageNumbers, page: int, index: int, selected: int, total: int) -> str:
    """index is zero-based in the sorted selection; total is the document length."""
    number = style.start + (page - 1 if style.mode == "document" else index)
    last = style.start + (total if style.mode == "document" else selected) - 1
    prefix = "Page " if style.format in ("page", "page-of-total") else ""
    suffix = f" of {last}" if style.format in ("of-total", "page-of-total") else ""
    return f"{prefix}{number}{suffix}"


def _place_stamp(
    page: int, width: float, height: float, unit: float, style: StampStyle, text: str,
    *, opacity: float = 1, rotation: float = 0,
) -> _TextStamp:
    size = style.size / unit
    margin = style.margin / unit
    if width <= 2 * margin or height <= 2 * margin:
        raise PdfToolError(f"Page {page} is too small for these margins. Reduce the margin.")
    text_width = max(size * 0.5, sum(font.width(ch) for font, run in _runs(style.family, text) for ch in run) * size / 1000)
    text_height = size * TEXT_LINE_HEIGHT
    angle = math.radians(rotation)
    cos, sin = abs(math.cos(angle)), abs(math.sin(angle))
    box_width = text_width * cos + text_height * sin
    box_height = text_width * sin + text_height * cos
    scale = min(1, (width - 2 * margin) / box_width, (height - 2 * margin) / box_height)
    if size * scale < 0.001:
        raise PdfToolError(f"The stamp on page {page} would be too small to render. Use less text or a larger font size.")
    box_width *= scale
    box_height *= scale
    if style.position == "center":
        vertical, horizontal = "middle", "center"
    else:
        vertical, horizontal = style.position.split("-")
    x = {"left": margin + box_width / 2, "center": width / 2, "right": width - margin - box_width / 2}[horizontal]
    y = {"top": margin + box_height / 2, "middle": height / 2, "bottom": height - margin - box_height / 2}[vertical]
    return _TextStamp(
        page=page, x=x, y=y, width=text_width * scale, height=text_height * scale,
        text=text, size=size * scale, color=style.color, family=style.family, opacity=opacity, rotation=rotation,
    )


def stamp(data: bytes, spec: str, name: str = "file", password: str = "") -> bytes:
    """Return the complete document with numbers/watermarks only on selected pages.

    The same bytes are rendered for the preview and offered for download.
    Margins and font sizes are physical points, including pages with /UserUnit.
    """
    with _open(data, name, password) as pdf:
        options = parse_stamps(spec, len(pdf.pages))
        painter = _Painter(pdf, ())
        for index, number in enumerate(options.pages):
            page = pdf.pages[number - 1]
            _, width, height = _display_frame(page)
            try:
                unit = float(page.get("/UserUnit", 1))
            except (TypeError, ValueError):
                unit = 1
            if not math.isfinite(unit) or unit <= 0:
                unit = 1
            edits: list[Edit] = []
            if options.watermark:
                w = options.watermark
                edits.append(_place_stamp(number, width, height, unit, w, w.text, opacity=w.opacity, rotation=w.rotation))
            if options.numbers:
                n = options.numbers
                text = page_number_text(n, number, index, len(options.pages), len(pdf.pages))
                edits.append(_place_stamp(number, width, height, unit, n, text))
            painter.paint(page, edits)
        painter.finish()
        return _save(pdf, password if pdf.is_encrypted else "", min_version="1.4")


_FONTS: dict[tuple[FontFamily, bool, bool], str] = {
    ("sans", False, False): "Helvetica",
    ("sans", True, False): "Helvetica-Bold",
    ("sans", False, True): "Helvetica-Oblique",
    ("sans", True, True): "Helvetica-BoldOblique",
    ("serif", False, False): "Times-Roman",
    ("serif", True, False): "Times-Bold",
    ("serif", False, True): "Times-Italic",
    ("serif", True, True): "Times-BoldItalic",
    ("mono", False, False): "Courier",
    ("mono", True, False): "Courier-Bold",
    ("mono", False, True): "Courier-Oblique",
    ("mono", True, True): "Courier-BoldOblique",
}

_KAPPA = 0.5522847498  # Bézier control distance that best approximates a quarter circle

Instruction = tuple[list[object], pikepdf.Operator]


def _op(operator: str, *operands: object, precision: int = 3) -> Instruction:
    return [round(v, precision) if isinstance(v, float) else v for v in operands], pikepdf.Operator(operator)


def _ellipse(cx: float, cy: float, rx: float, ry: float) -> list[Instruction]:
    kx, ky = rx * _KAPPA, ry * _KAPPA
    return [
        _op("m", cx + rx, cy),
        _op("c", cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry),
        _op("c", cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy),
        _op("c", cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry),
        _op("c", cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy),
        _op("h"),
    ]


def _text_lines(text: str) -> list[str]:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    for line in lines:
        for ch in line:
            if ord(ch) < 32 or ch == "\x7f":
                raise PdfToolError("Text can't contain control characters.")
    return lines


def _win_ansi(lines: Sequence[str]) -> list[pikepdf.String] | None:
    """The lines in the encoding the standard fonts use, or None if a character isn't in it."""
    try:
        return [pikepdf.String(line.encode("cp1252")) for line in lines]
    except UnicodeEncodeError:
        return None


# Bold and italic are made up for embedded fonts, the way browsers do it: a
# stroke around the glyphs about 1/24 em wide, and a slant of about 14 degrees.
_FAKE_BOLD_STROKE = 0.04
_FAKE_ITALIC_SKEW = 0.25


class _Embedded:
    """An embedded font being built up: its dictionary is filled in once every character is known."""

    def __init__(self, pdf: pikepdf.Pdf, font: fontlib.Font):
        self.font = font
        self.obj = pdf.make_indirect(pikepdf.Dictionary())
        self.chars: set[str] = set()


def _region_unit(page: pikepdf.Page) -> float:
    try:
        unit = float(page.get("/UserUnit", 1))
    except (TypeError, ValueError):
        unit = 1
    if not math.isfinite(unit) or unit <= 0:
        unit = 1
    return unit


def _region_boxes(page: pikepdf.Page, regions: Sequence[RegionEdit], *, source: bool) -> None:
    """Check each end in its own page's display frame and physical units."""
    if not regions:
        return
    frame, width, height = _display_frame(page)
    unit = _region_unit(page)
    boxes = []
    matrix = pikepdf.Matrix(*frame)
    number = page.index + 1
    label = "source" if source else "destination"
    for region in regions:
        box = region.source if source else (region.x, region.y, region.width, region.height)
        x, y, w, h = box
        if (not all(math.isfinite(v) for v in box) or min(x, y) < 0 or min(w, h) < 2
                or x + w > width * unit + 0.02 or y + h > height * unit + 0.02):
            raise PdfToolError(f"Region {label} must fit inside page {number} and be at least 2 points wide and high.")
        native = matrix.transform(pikepdf.Rectangle(x / unit, height - (y + h) / unit, (x + w) / unit, height - y / unit))
        for annotation in page.get("/Annots", []):
            rect = _box(annotation.get("/Rect"))
            if rect is None or (rect[0] < native.urx and rect[2] > native.llx and rect[1] < native.ury and rect[3] > native.lly):
                raise PdfToolError(f"A region on page {number} touches a link, annotation or form field. Choose an area away from these objects.")
        if source and not region.copy:
            if any(x < sx + sw and x + w > sx and y < sy + sh and y + h > sy for sx, sy, sw, sh in boxes):
                raise PdfToolError(f"Source regions on page {number} overlap. Select separate areas of the original page.")
            boxes.append(box)


def _region_original(pdf: pikepdf.Pdf, page: pikepdf.Page) -> pikepdf.Object:
    """Freeze content and resources before adding masks or new XObjects."""
    original = page.as_form_xobject(handle_transformations=False)
    form = pdf.make_stream(original.read_bytes())
    for key, value in original.items():
        if key not in ("/Length", "/Filter", "/DecodeParms"):
            form[key] = value
    # Resource subdictionaries may be shared with the page. Detach them so
    # adding this form to the page cannot make the form refer to itself.
    resources = pikepdf.Dictionary(original.get("/Resources", pikepdf.Dictionary()))
    for key, value in list(resources.items()):
        if isinstance(value, pikepdf.Dictionary):
            resources[key] = pikepdf.Dictionary(value)
    form.Resources = resources
    return form


class _Painter:
    """Draws edits onto pages, sharing fonts, images and graphics states between them."""

    def __init__(self, pdf: pikepdf.Pdf, images: Sequence[tuple[str, bytes]]):
        self.pdf = pdf
        self.images = images
        self.fonts: dict[tuple[FontFamily, bool, bool], pikepdf.Object] = {}
        self.embedded: dict[str, _Embedded] = {}
        self.pictures: dict[int, pikepdf.Object] = {}
        self.multiply: pikepdf.Object | None = None
        self.opacities: dict[float, pikepdf.Object] = {}
        self.region_sources: dict[int, pikepdf.Object] = {}
        # Resource names are per page, so remember what each page calls each object.
        self.names: dict[tuple[int, str], pikepdf.Name] = {}

    def paint(self, page: pikepdf.Page, edits: Sequence[Edit], *, vacated: Sequence[RegionEdit] = ()) -> None:
        matrix, _, height = _display_frame(page)
        ops: list[Instruction] = [_op("q"), _op("cm", *matrix)]
        regions = [e for e in edits if isinstance(e, RegionEdit)]
        unit = _region_unit(page) if regions or vacated else 1.0
        if vacated:
            ops += [_op("q"), _op("rg", 1, 1, 1)]
            for region in vacated:
                x, y, width, h = region.source
                ops += [_op("re", x / unit, height - (y + h) / unit, width / unit, h / unit, precision=9), _op("f")]
            ops.append(_op("Q"))
        for e in edits:
            # A sampled page may rely on the default graphics state. Do not
            # let earlier added text/shapes change its colors or line styles.
            if regions:
                ops.append(_op("q"))
            if isinstance(e, _TextStamp):
                ops += self._stamp(page, e, height)
            elif isinstance(e, TextEdit):
                ops += self._text(page, e, height)
            elif isinstance(e, ImageEdit):
                ops += self._image(page, e, height)
            elif isinstance(e, RegionEdit):
                origin = self.pdf.pages[e.origin_page - 1]
                source_matrix, _, source_height = _display_frame(origin)
                source_unit = _region_unit(origin)
                original_name = self._resource(page, f"region-original:{e.origin_page}", self.region_sources[e.origin_page], pikepdf.Name.XObject, "Region")
                sx, sy, sw, sh = (v / source_unit for v in e.source)
                x, y, w, h = (v / unit for v in (e.x, e.y, e.width, e.height))
                source_bottom = source_height - sy - sh
                inverse = pikepdf.Matrix(*source_matrix).inverse()
                # Rotate within the destination box in the displayed frame.
                # PDF y points upward, so clockwise 90 degrees has negative b.
                a, b, c, d, ox, oy = {
                    0: (w / sw, 0, 0, h / sh, 0, 0),
                    90: (0, -h / sw, w / sh, 0, 0, h),
                    180: (-w / sw, 0, 0, -h / sh, w, h),
                    270: (0, h / sw, -w / sh, 0, w, 0),
                }[e.rotation]
                ops += [
                    _op("q"),
                    _op("cm", a, b, c, d, x + ox - a * sx - c * source_bottom, height - y - h + oy - b * sx - d * source_bottom, precision=9),
                    _op("re", sx, source_bottom, sw, sh, precision=9), _op("W"), _op("n"),
                    _op("q"), _op("rg", 1, 1, 1), _op("re", sx, source_bottom, sw, sh, precision=9), _op("f"), _op("Q"),
                    _op("cm", *inverse.shorthand), _op("Do", original_name), _op("Q"),
                ]
            elif isinstance(e, ShapeEdit):
                ops += self._shape(e, height)
            elif isinstance(e, HighlightEdit):
                ops += self._highlight(page, e, height)
            elif isinstance(e, LineEdit):
                ops += self._stroke([(e.x1, e.y1), (e.x2, e.y2)], e.stroke, e.stroke_width, height)
            else:
                ops += self._stroke(e.points, e.stroke, e.stroke_width, height)
            if regions:
                ops.append(_op("Q"))
        ops.append(_op("Q"))
        # Wrap what is already there so its graphics state can't leak into the edits.
        page.contents_add(b"q\n", prepend=True)
        page.contents_add(b"Q\n" + pikepdf.unparse_content_stream(ops))

    def _resource(self, page: pikepdf.Page, key: str, obj: pikepdf.Object, kind: pikepdf.Name, prefix: str) -> pikepdf.Name:
        name = self.names.get((page.index, key))
        if name is None:
            name = self.names[(page.index, key)] = page.add_resource(obj, kind, prefix=prefix)
        return name

    def finish(self) -> None:
        """Write the embedded fonts, now that every character they need is known."""
        for rec in self.embedded.values():
            for key, value in rec.font.embed(self.pdf, rec.chars).items():
                rec.obj[key] = value

    def _text(self, page: pikepdf.Page, e: TextEdit, height: float) -> list[Instruction]:
        lines = _text_lines(e.text)
        encoded = _win_ansi(lines)
        if encoded is None:
            return self._embedded_text(page, e, lines, height)
        key = (e.family, e.bold, e.italic)
        font = self.fonts.get(key)
        if font is None:
            font = self.fonts[key] = self.pdf.make_indirect(
                pikepdf.Dictionary(
                    Type=pikepdf.Name.Font,
                    Subtype=pikepdf.Name.Type1,
                    BaseFont=pikepdf.Name("/" + _FONTS[key]),
                    Encoding=pikepdf.Name.WinAnsiEncoding,
                )
            )
        name = self._resource(page, _FONTS[key], font, pikepdf.Name.Font, "F")
        ops = [
            _op("BT"),
            _op("Tf", name, e.size),
            _op("rg", *e.color),
            _op("TL", e.size * TEXT_LINE_HEIGHT),
            _op("Td", e.x, height - e.y - e.size * TEXT_ASCENT),
        ]
        for i, line in enumerate(encoded):
            if i:
                ops.append(_op("T*"))
            ops.append(_op("Tj", line))
        ops.append(_op("ET"))
        return ops

    def _stamp(self, page: pikepdf.Page, e: _TextStamp, height: float) -> list[Instruction]:
        state = self.opacities.get(e.opacity)
        if state is None:
            state = self.opacities[e.opacity] = self.pdf.make_indirect(
                pikepdf.Dictionary(Type=pikepdf.Name.ExtGState, ca=e.opacity, CA=e.opacity, BM=pikepdf.Name.Normal)
            )
        name = self._resource(page, f"stamp-opacity:{e.opacity}", state, pikepdf.Name.ExtGState, "GS")
        angle = math.radians(-e.rotation)  # display coordinates have y down
        cos, sin = math.cos(angle), math.sin(angle)
        text = TextEdit(page=e.page, x=-e.width / 2, y=-e.height / 2, text=e.text, size=e.size, color=e.color, family=e.family)
        return [
            _op("q"), _op("gs", name), _op("cm", cos, sin, -sin, cos, e.x, height - e.y),
            *self._embedded_text(page, text, [e.text], 0), _op("Q"),
        ]

    def _embedded_text(self, page: pikepdf.Page, e: TextEdit, lines: Sequence[str], height: float) -> list[Instruction]:
        """Text beyond the standard fonts, set in the embedded ones, falling back character by character."""
        r, g, b = e.color
        ops = [_op("q"), _op("BT"), _op("rg", r, g, b)]
        if e.bold:
            ops += [_op("RG", r, g, b), _op("w", e.size * _FAKE_BOLD_STROKE), _op("Tr", 2)]
        skew = _FAKE_ITALIC_SKEW if e.italic else 0
        for i, line in enumerate(lines):
            # Each line gets its own matrix, so the slant is about its own baseline.
            ops.append(_op("Tm", 1, 0, skew, 1, e.x, height - e.y - e.size * (TEXT_ASCENT + i * TEXT_LINE_HEIGHT)))
            for font, run in _runs(e.family, line):
                rec = self.embedded.get(font.name)
                if rec is None:
                    rec = self.embedded[font.name] = _Embedded(self.pdf, font)
                rec.chars.update(run)
                name = self._resource(page, "embedded:" + font.name, rec.obj, pikepdf.Name.Font, "F")
                ops += [_op("Tf", name, e.size), _op("Tj", pikepdf.String(font.encode(run)))]
        ops += [_op("ET"), _op("Q")]
        return ops

    def _image(self, page: pikepdf.Page, e: ImageEdit, height: float) -> list[Instruction]:
        picture = self.pictures.get(e.image)
        if picture is None:
            picture = self.pictures[e.image] = _image_xobject(self.pdf, *self.images[e.image])
        name = self._resource(page, f"image{e.image}", picture, pikepdf.Name.XObject, "Im")
        return [
            _op("q"),
            _op("cm", e.width, 0, 0, e.height, e.x, height - e.y - e.height),
            _op("Do", name),
            _op("Q"),
        ]

    def _shape(self, e: ShapeEdit, height: float) -> list[Instruction]:
        ops = [_op("q")]
        if e.stroke:
            ops += [_op("RG", *e.stroke), _op("w", e.stroke_width)]
        if e.fill:
            ops.append(_op("rg", *e.fill))
        bottom = height - e.y - e.height
        if e.shape == "rect":
            ops.append(_op("re", e.x, bottom, e.width, e.height))
        else:
            ops += _ellipse(e.x + e.width / 2, bottom + e.height / 2, e.width / 2, e.height / 2)
        ops.append(_op("B" if e.stroke and e.fill else "S" if e.stroke else "f"))
        ops.append(_op("Q"))
        return ops

    def _highlight(self, page: pikepdf.Page, e: HighlightEdit, height: float) -> list[Instruction]:
        if self.multiply is None:
            self.multiply = self.pdf.make_indirect(
                pikepdf.Dictionary(Type=pikepdf.Name.ExtGState, BM=pikepdf.Name.Multiply)
            )
        name = self._resource(page, "multiply", self.multiply, pikepdf.Name.ExtGState, "GS")
        return [
            _op("q"),
            _op("gs", name),
            _op("rg", *e.color),
            _op("re", e.x, height - e.y - e.height, e.width, e.height),
            _op("f"),
            _op("Q"),
        ]

    def _stroke(self, points: Sequence[Point], color: Color, width: float, height: float) -> list[Instruction]:
        ops = [_op("q"), _op("RG", *color), _op("w", width), _op("J", 1), _op("j", 1)]
        x, y = points[0]
        ops.append(_op("m", x, height - y))
        # A lone point still needs a segment; with round caps a zero-length one is a dot.
        for x, y in points[1:] or points[:1]:
            ops.append(_op("l", x, height - y))
        ops += [_op("S"), _op("Q")]
        return ops


def _runs(family: FontFamily, line: str) -> list[tuple[fontlib.Font, str]]:
    """The line split into stretches set in one font: the first in the family's chain that has each character."""
    runs: list[tuple[fontlib.Font, str]] = []
    for ch in line:
        font = fontlib.pick(family, ch)
        if font is None:
            raise PdfToolError(f'"{ch}" can\'t be written: no font in pdfer has it.')
        if runs and runs[-1][0] is font:
            runs[-1] = (font, runs[-1][1] + ch)
        else:
            runs.append((font, ch))
    return runs


def _image_xobject(pdf: pikepdf.Pdf, name: str, data: bytes) -> pikepdf.Stream:
    """An image XObject for the picture, honouring EXIF orientation.

    Plain JPEGs are embedded as they are. Everything else is stored
    losslessly, with a soft mask when the picture has transparency.
    """
    try:
        with Image.open(BytesIO(data)) as opened:
            opened.load()
            kind = opened.format
            orientation = opened.getexif().get(0x0112, 1)
            image = ImageOps.exif_transpose(opened)
    except Exception:  # noqa: BLE001 - PIL raises a mixed bag for data it can't read
        raise PdfToolError(f"{name} isn't an image pdfer can read.") from None

    def stream(payload: bytes, mode: str, **extra: object) -> pikepdf.Stream:
        return pdf.make_stream(
            payload,
            Type=pikepdf.Name.XObject,
            Subtype=pikepdf.Name.Image,
            Width=image.width,
            Height=image.height,
            ColorSpace=pikepdf.Name.DeviceGray if mode == "L" else pikepdf.Name.DeviceRGB,
            BitsPerComponent=8,
            **extra,
        )

    if kind == "JPEG" and orientation == 1 and image.mode in ("RGB", "L"):
        return stream(data, image.mode, Filter=pikepdf.Name.DCTDecode)

    alpha = None
    if image.mode in ("RGBA", "RGBa", "LA", "La", "PA") or (image.mode == "P" and "transparency" in image.info):
        image = image.convert("RGBA")
        alpha = image.getchannel("A")
        image = image.convert("RGB")
    elif image.mode in ("L", "1", "I", "I;16", "F"):
        image = image.convert("L")
    else:
        image = image.convert("RGB")

    out = stream(zlib.compress(image.tobytes()), image.mode, Filter=pikepdf.Name.FlateDecode)
    if alpha is not None:
        out.SMask = stream(zlib.compress(alpha.tobytes()), "L", Filter=pikepdf.Name.FlateDecode)
    return out


# --- Photo: crop a picture to passport or visa size ---------------------------


@dataclass(frozen=True)
class PhotoCrop:
    """The part of a picture to keep, in pixels of the picture as a browser shows it.

    (`cx`, `cy`) is the centre and `width` × `height` the size of the crop
    after the picture has been turned `angle` degrees clockwise about that
    centre; with an angle of 0 it is a plain upright rectangle, with 90 the
    picture comes out turned on its side. Pixels count from the top-left
    corner with the EXIF orientation already applied, which is how browsers
    show pictures.
    """

    cx: float
    cy: float
    width: float
    height: float
    angle: float = 0.0


def parse_photo_crop(spec: str) -> PhotoCrop:
    """Read a crop from JSON with `cx`, `cy`, `width`, `height` and an optional `angle`."""
    try:
        raw = json.loads(spec)
    except ValueError:
        raise PdfToolError("The crop isn't valid JSON.") from None
    if not isinstance(raw, dict):
        raise PdfToolError("The crop must be a JSON object.")
    values: dict[str, float] = {}
    for key in ("cx", "cy", "width", "height", "angle"):
        value = raw.get(key, 0.0 if key == "angle" else None)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise PdfToolError(f"The crop needs a number for {key}.")
        values[key] = float(value)
    if values["width"] <= 0 or values["height"] <= 0:
        raise PdfToolError("The crop's width and height must be more than zero.")
    return PhotoCrop(**values)


def _open_photo(data: bytes, name: str) -> Image.Image:
    """The picture as a browser shows it: EXIF orientation applied, transparency flattened onto white."""
    try:
        with Image.open(BytesIO(data)) as opened:
            opened.load()
            image = ImageOps.exif_transpose(opened)
    except Exception:  # noqa: BLE001 - PIL raises a mixed bag for data it can't read
        raise PdfToolError(f"{name} isn't an image pdfer can read.") from None
    rgba = image.convert("RGBA")
    flat = Image.new("RGB", rgba.size, "white")
    flat.paste(rgba, mask=rgba.getchannel("A"))
    return flat


def _quad(crop: PhotoCrop) -> tuple[float, ...]:
    """The crop's corners in the picture: top-left, bottom-left, bottom-right, top-right, as Image.transform wants."""
    a = math.radians(crop.angle)
    cos, sin = math.cos(a), math.sin(a)
    hw, hh = crop.width / 2, crop.height / 2
    corners: list[float] = []
    for dx, dy in ((-hw, -hh), (-hw, hh), (hw, hh), (hw, -hh)):
        # Undo the clockwise turn: rotate the offset from the centre by -angle.
        corners += [crop.cx + dx * cos + dy * sin, crop.cy - dx * sin + dy * cos]
    return tuple(corners)


def _cut(image: Image.Image, crop: PhotoCrop, size: tuple[int, int]) -> Image.Image:
    """The crop, resampled to `size` pixels. Parts outside the picture come out white."""
    width, height = size
    # Shrink first when the crop holds many more pixels than the output needs, so the
    # bicubic resampling below doesn't alias; reduce() averages whole blocks of pixels.
    factor = int(min(crop.width / width, crop.height / height))
    if factor >= 2:
        image = image.reduce(factor)
        crop = PhotoCrop(crop.cx / factor, crop.cy / factor, crop.width / factor, crop.height / factor, crop.angle)
    return image.transform(size, Image.Transform.QUAD, _quad(crop), Image.Resampling.BICUBIC, fillcolor="white")


def _jpeg(image: Image.Image, dpi: int, max_bytes: int | None) -> bytes:
    """Encode as a JPEG that says it is `dpi`, trading quality for size until it fits in `max_bytes` when given."""
    out = b""
    for quality in (92, 88, 84, 80, 75, 70, 65, 60, 55, 50, 45, 40):
        buf = BytesIO()
        image.save(buf, "JPEG", quality=quality, dpi=(dpi, dpi), optimize=True)
        out = buf.getvalue()
        if max_bytes is None or len(out) <= max_bytes:
            break
    return out


MAX_PHOTO_SIDE = 6000


def crop_photo(
    data: bytes,
    crop: PhotoCrop,
    size: tuple[int, int],
    dpi: int = 300,
    name: str = "file",
    max_bytes: int | None = None,
) -> bytes:
    """Cut `crop` out of the picture and resample it to `size` pixels, as a JPEG marked `dpi`.

    `max_bytes` lowers the JPEG quality step by step until the file fits; when
    even the lowest step is too big, that one is returned.
    """
    width, height = size
    if not (1 <= width <= MAX_PHOTO_SIDE and 1 <= height <= MAX_PHOTO_SIDE):
        raise PdfToolError(f"The photo size must be between 1 and {MAX_PHOTO_SIDE} pixels each way.")
    if not 1 <= dpi <= 2400:
        raise PdfToolError("The resolution must be between 1 and 2400 dpi.")
    return _jpeg(_cut(_open_photo(data, name), crop, size), dpi, max_bytes)


Paper = Literal["4x6", "a4", "letter"]

PAPERS: dict[Paper, tuple[float, float]] = {
    "4x6": (101.6, 152.4),
    "a4": (210.0, 297.0),
    "letter": (215.9, 279.4),
}
"""Paper sizes in millimetres, portrait."""

SHEET_MARGIN = 4.0
"""Millimetres kept clear around the edge of a sheet, where most printers can't print anyway."""

SHEET_GAP = 2.0
"""Millimetres between photos on a sheet: room for the cut."""

SHEET_DPI = 300


def sheet_layout(paper: tuple[float, float], photo: tuple[float, float]) -> tuple[int, int, bool]:
    """How many photos fit on the paper: (columns, rows, whether the paper is turned landscape).

    Both sizes are in millimetres. The paper is turned when that fits more photos.
    """

    def fit(paper_w: float, paper_h: float) -> tuple[int, int]:
        cols = int((paper_w - 2 * SHEET_MARGIN + SHEET_GAP) // (photo[0] + SHEET_GAP))
        rows = int((paper_h - 2 * SHEET_MARGIN + SHEET_GAP) // (photo[1] + SHEET_GAP))
        return max(cols, 0), max(rows, 0)

    portrait = fit(*paper)
    landscape = fit(paper[1], paper[0])
    if landscape[0] * landscape[1] > portrait[0] * portrait[1]:
        return (*landscape, True)
    if portrait[0] * portrait[1] == 0:
        return (0, 0, False)
    return (*portrait, False)


def photo_sheet(
    data: bytes,
    crop: PhotoCrop,
    photo: tuple[float, float],
    paper: Paper,
    name: str = "file",
) -> tuple[bytes, int]:
    """A one-page PDF of photo paper holding as many copies of the crop as fit, and how many that is.

    `photo` is the printed size in millimetres. The copies are spaced for
    cutting, with light cut lines running between them and out to the edges.
    """
    if paper not in PAPERS:
        raise PdfToolError("Unknown paper size.")
    photo_w, photo_h = photo
    if not (10 <= photo_w <= 150 and 10 <= photo_h <= 150):
        raise PdfToolError("The photo must be between 10 and 150 mm each way.")
    cols, rows, landscape = sheet_layout(PAPERS[paper], photo)
    if cols * rows == 0:
        raise PdfToolError("The photo doesn't fit on that paper.")
    paper_w, paper_h = PAPERS[paper]
    if landscape:
        paper_w, paper_h = paper_h, paper_w

    def px(mm: float) -> int:
        return round(mm / 25.4 * SHEET_DPI)

    tile = _cut(_open_photo(data, name), crop, (px(photo_w), px(photo_h)))
    sheet = Image.new("RGB", (px(paper_w), px(paper_h)), "white")

    # Centre the grid on the sheet.
    left = (paper_w - (cols * photo_w + (cols - 1) * SHEET_GAP)) / 2
    top = (paper_h - (rows * photo_h + (rows - 1) * SHEET_GAP)) / 2
    xs = [left + c * (photo_w + SHEET_GAP) for c in range(cols)]
    ys = [top + r * (photo_h + SHEET_GAP) for r in range(rows)]

    # Cut lines along every photo edge, the whole way across; the photos cover their own half.
    draw = ImageDraw.Draw(sheet)
    grey = (190, 190, 190)
    for x in xs:
        for edge in (x, x + photo_w):
            draw.line([(px(edge), 0), (px(edge), sheet.height)], fill=grey, width=2)
    for y in ys:
        for edge in (y, y + photo_h):
            draw.line([(0, px(edge)), (sheet.width, px(edge))], fill=grey, width=2)
    for y in ys:
        for x in xs:
            sheet.paste(tile, (px(x), px(y)))

    buf = BytesIO()
    sheet.save(buf, "JPEG", quality=92, dpi=(SHEET_DPI, SHEET_DPI), optimize=True)
    return img2pdf.convert(buf.getvalue()), cols * rows


# --- Compress images: smaller copies of pictures on their own -----------------

ImageFormat = Literal["keep", "jpeg", "png", "webp"]

_IMAGE_MEDIA: dict[str, tuple[str, str]] = {
    # format: (file extension, media type)
    "jpeg": ("jpg", "image/jpeg"),
    "png": ("png", "image/png"),
    "webp": ("webp", "image/webp"),
}

_IMAGE_LEVELS: dict[str, tuple[int | None, int]] = {
    # level: (longest side in px, or None to keep the size; JPEG and WebP quality).
    # "balanced" and "strong" use the same limits as PDF compression.
    "light": (None, 85),
    "balanced": _IMAGE_LIMITS["balanced"],
    "strong": _IMAGE_LIMITS["strong"],
}

_LOWEST_QUALITY = 40
_SMALLEST_SIDE = 64


@dataclass(frozen=True)
class CompressedImage:
    """A picture made smaller: its new file name, bytes and media type, and the sizes before and after."""

    name: str
    data: bytes
    media_type: str
    before: int
    after: int


def compress_image(
    name: str,
    data: bytes,
    level: CompressLevel,
    fmt: ImageFormat = "keep",
    max_bytes: int | None = None,
) -> CompressedImage:
    """Return a smaller copy of one picture.

    Every level re-encodes the picture without its metadata, with the EXIF
    orientation applied first and any colour profile kept. "balanced" and
    "strong" also downscale it so the longer side is at most 1600 px or
    1000 px and encode JPEGs and WebPs at a lower quality; "strong" stores
    PNGs with a 256-colour palette. `fmt` converts the picture: "keep" leaves
    JPEGs, PNGs and WebPs as they are and makes anything else a PNG when it
    has transparency, else a JPEG. With `max_bytes` the quality, then the
    size, go down until the file fits. When the format is kept, no limit is
    set and nothing shrank, the original bytes come back unchanged.
    """
    if level not in _IMAGE_LEVELS:
        raise PdfToolError(f"{level!r} isn't a compression level: light, balanced or strong.")
    if fmt != "keep" and fmt not in _IMAGE_MEDIA:
        raise PdfToolError(f"{fmt!r} isn't an image format: keep, jpeg, png or webp.")
    if max_bytes is not None and max_bytes < 1:
        raise PdfToolError("The size limit must be at least 1 byte.")

    try:
        with Image.open(BytesIO(data)) as opened:
            opened.load()
            kind = (opened.format or "").lower()
            icc = opened.info.get("icc_profile")
            image = ImageOps.exif_transpose(opened)
    except Exception:  # noqa: BLE001 - PIL raises a mixed bag for data it can't read
        raise PdfToolError(f"{name} isn't an image pdfer can read.") from None

    image = _plain_mode(image)
    transparent = image.mode in ("RGBA", "LA")
    target = fmt if fmt != "keep" else kind if kind in _IMAGE_MEDIA else "png" if transparent else "jpeg"

    max_side, quality = _IMAGE_LEVELS[level]
    if max_side:
        image = _fit_within(image, max_side)
    palette = level == "strong"

    out = _encode_image(image, target, quality, palette, icc)
    if max_bytes is not None:
        # Lossy formats give up quality first; PNGs go to a palette. Then the pixels go.
        while len(out) > max_bytes and target != "png" and quality > _LOWEST_QUALITY:
            quality = max(_LOWEST_QUALITY, quality - 10)
            out = _encode_image(image, target, quality, palette, icc)
        if len(out) > max_bytes and target == "png" and not palette:
            palette = True
            out = _encode_image(image, target, quality, palette, icc)
        while len(out) > max_bytes and max(image.size) > _SMALLEST_SIDE:
            image = _fit_within(image, max(_SMALLEST_SIDE, round(max(image.size) * 0.8)))
            out = _encode_image(image, target, quality, palette, icc)

    ext, media = _IMAGE_MEDIA[target]
    stem = name.rsplit(".", 1)[0] if "." in name else name
    new_name = f"{stem or 'image'}_compressed.{ext}"
    if fmt == "keep" and max_bytes is None and len(out) >= len(data):
        return CompressedImage(new_name, data, media, len(data), len(data))
    return CompressedImage(new_name, out, media, len(data), len(out))


def _plain_mode(image: Image.Image) -> Image.Image:
    """The picture as RGB, RGBA, L or LA, whichever loses nothing it has."""
    if image.mode in ("RGB", "RGBA", "L", "LA"):
        return image
    if image.mode == "P":
        return image.convert("RGBA" if "transparency" in image.info else "RGB")
    if image.mode in ("1", "I", "I;16", "F"):
        return image.convert("L")
    if image.mode == "PA":
        return image.convert("RGBA")
    return image.convert("RGBA" if "A" in image.getbands() else "RGB")


def _fit_within(image: Image.Image, max_side: int) -> Image.Image:
    """Downscale so the longer side is at most `max_side`; smaller pictures are left alone."""
    width, height = image.size
    scale = max_side / max(width, height)
    if scale >= 1:
        return image
    return image.resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.Resampling.LANCZOS)


def _encode_image(image: Image.Image, target: str, quality: int, palette: bool, icc: bytes | None) -> bytes:
    """Encode without metadata, apart from the colour profile. `palette` stores a PNG in 256 colours."""
    buf = BytesIO()
    if target == "jpeg":
        _opaque(image).save(buf, "JPEG", quality=quality, optimize=True, progressive=True, icc_profile=icc)
    elif target == "webp":
        colour = image.convert("RGBA" if image.mode in ("RGBA", "LA") else "RGB")
        colour.save(buf, "WEBP", quality=quality, method=6, icc_profile=icc)
    else:
        _png_ready(image, palette).save(buf, "PNG", optimize=True, icc_profile=icc)
    return buf.getvalue()


def _opaque(image: Image.Image) -> Image.Image:
    """Transparency flattened onto white, as JPEG has none."""
    if image.mode == "LA":
        image = image.convert("RGBA")
    if image.mode == "RGBA":
        flat = Image.new("RGB", image.size, "white")
        flat.paste(image, mask=image.getchannel("A"))
        return flat
    return image


def _png_ready(image: Image.Image, palette: bool) -> Image.Image:
    """A palette PNG when that loses nothing (256 colours or fewer) or when asked for; otherwise unchanged."""
    if image.mode not in ("RGB", "RGBA"):
        return image
    if not palette and image.getcolors(256) is None:
        return image
    if image.mode == "RGBA":
        return image.quantize(256, method=Image.Quantize.FASTOCTREE)
    return image.convert("P", palette=Image.Palette.ADAPTIVE, colors=256)
