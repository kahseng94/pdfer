"""Photo tools: resize, crop, rotate, convert, adjust and metadata, as pure functions over bytes.

Every photo goes through one pipeline, with its EXIF orientation applied
first: turn in quarter turns, flip, crop, resize, adjust, then encode. An edit
that touches no pixels and keeps the format leaves the compressed picture data
alone, so taking the metadata out of a JPEG never recompresses it.

HEIC and HEIF photos, as iPhones take them, are read through pi-heif, the
decode-only build of pillow-heif, and its libheif. Without the package, or its
native library, every other format still works and a HEIC is simply a picture
pdfer can't read.
"""

import json
import math
import re
import struct
import warnings
import zlib
from collections.abc import Callable
from dataclasses import dataclass
from io import BytesIO
from typing import Literal

from PIL import ExifTags, Image, ImageEnhance, ImageOps

from pdfer.core import PdfToolError, PhotoCrop, _plain_mode, _png_ready, _quad, photo_crop_from

try:
    from pi_heif import get_file_mimetype as _heif_media_type, register_heif_opener
except ImportError:  # pragma: no cover - a build without pi-heif still serves every other format
    _heif_media_type = None
else:
    try:
        register_heif_opener()
    except Exception:  # noqa: BLE001 - the package without its native libheif can't open anything
        _heif_media_type = None

MAX_SIDE = 10_000
"""The most pixels a resized or cropped photo may have along either side."""

MAX_PERCENT = 400

Fit = Literal["contain", "cover", "stretch"]
Flip = Literal["none", "horizontal", "vertical"]
Metadata = Literal["keep", "no-location", "none"]
OutputFormat = Literal["keep", "jpeg", "png", "webp"]

_FITS = ("contain", "cover", "stretch")
_FLIPS = ("none", "horizontal", "vertical")
_METADATA = ("keep", "no-location", "none")
_FORMATS = ("keep", "jpeg", "png", "webp")
_COLOUR = re.compile(r"^#([0-9a-fA-F]{6})$")
_SUFFIX = re.compile(r"^[a-z0-9-]{0,24}$")

_MEDIA: dict[str, tuple[str, str]] = {
    # format: (file extension, media type)
    "jpeg": ("jpg", "image/jpeg"),
    "png": ("png", "image/png"),
    "webp": ("webp", "image/webp"),
}

_ORIENTATION = 0x0112
_GPS = ExifTags.IFD.GPSInfo
_EXIF_PREFIX = b"Exif\x00\x00"


@dataclass(frozen=True)
class Resize:
    """A new size: exact sides, a percentage of the current size, or a longest side.

    With both `width` and `height`, `fit` says how: `contain` keeps the
    proportions and fits inside, `cover` keeps them and fills the box, cutting
    the overhang from the middle, and `stretch` changes them. Unless `enlarge`
    is set, a photo is never made bigger than it is.
    """

    width: int | None = None
    height: int | None = None
    percent: float | None = None
    longest: int | None = None
    fit: Fit = "contain"
    enlarge: bool = False


@dataclass(frozen=True)
class Adjust:
    """Enhancement factors, where 1 leaves the photo as it is; see PIL.ImageEnhance."""

    brightness: float = 1.0
    contrast: float = 1.0
    saturation: float = 1.0
    sharpness: float = 1.0
    grayscale: bool = False

    def is_identity(self) -> bool:
        return not self.grayscale and all(
            f == 1.0 for f in (self.brightness, self.contrast, self.saturation, self.sharpness)
        )


@dataclass(frozen=True)
class PhotoEdit:
    """Everything to do to a photo, applied in the order of the fields.

    `rotate` is clockwise in quarter turns. `crop` counts pixels of the photo
    after it has been turned and flipped. `quality` applies to JPEG and WebP
    output, and `background` is what shows through transparency in a JPEG.
    The result is named `<stem>_<suffix>.<ext>`, or `<stem>.<ext>` when the
    suffix is empty.
    """

    rotate: int = 0
    flip: Flip = "none"
    crop: PhotoCrop | None = None
    resize: Resize | None = None
    adjust: Adjust | None = None
    format: OutputFormat = "keep"
    quality: int = 90
    background: tuple[int, int, int] = (255, 255, 255)
    metadata: Metadata = "keep"
    suffix: str = "edited"

    def changes_pixels(self) -> bool:
        return bool(
            self.rotate or self.flip != "none" or self.crop or self.resize or (self.adjust and not self.adjust.is_identity())
        )


@dataclass(frozen=True)
class EditedPhoto:
    """The result: its file name, bytes and media type, its pixel size, and the file sizes before and after."""

    name: str
    data: bytes
    media_type: str
    width: int
    height: int
    before: int
    after: int


# --- Reading the edit ------------------------------------------------------------


def _number(
    raw: dict[str, object], key: str, *, low: float, high: float, integer: bool = False, default: float | None = None
) -> float | None:
    value = raw.get(key)
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise PdfToolError(f"The edit needs a number for {key}.")
    if integer:
        if value != int(value):
            raise PdfToolError(f"{key} must be a whole number.")
        value = int(value)
    if not low <= value <= high:
        raise PdfToolError(f"{key} must be between {low:g} and {high:g}.")
    return value


def _choice(raw: dict[str, object], key: str, choices: tuple[str, ...], default: str) -> str:
    value = raw.get(key, default)
    if value not in choices:
        raise PdfToolError(f"{key} must be one of {', '.join(choices)}.")
    return value  # type: ignore[return-value]


def _flag(raw: dict[str, object], key: str, default: bool = False) -> bool:
    value = raw.get(key, default)
    if not isinstance(value, bool):
        raise PdfToolError(f"{key} must be true or false.")
    return value


def _object(raw: dict[str, object], key: str) -> dict[str, object] | None:
    value = raw.get(key)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise PdfToolError(f"The {key} must be a JSON object.")
    return value


def parse_resize(raw: dict[str, object]) -> Resize:
    width = _number(raw, "width", low=1, high=MAX_SIDE, integer=True)
    height = _number(raw, "height", low=1, high=MAX_SIDE, integer=True)
    percent = _number(raw, "percent", low=1, high=MAX_PERCENT)
    longest = _number(raw, "longest", low=1, high=MAX_SIDE, integer=True)
    given = [key for key, value in (("width", width), ("height", height), ("percent", percent), ("longest", longest)) if value is not None]
    if not given:
        raise PdfToolError("The resize needs a width, height, percentage or longest side.")
    if (percent is not None or longest is not None) and len(given) > 1:
        raise PdfToolError("A percentage or longest side can't be combined with other sizes.")
    return Resize(
        int(width) if width is not None else None,
        int(height) if height is not None else None,
        float(percent) if percent is not None else None,
        int(longest) if longest is not None else None,
        _choice(raw, "fit", _FITS, "contain"),  # type: ignore[arg-type]
        _flag(raw, "enlarge"),
    )


def parse_adjust(raw: dict[str, object]) -> Adjust:
    factors = {key: float(_number(raw, key, low=0, high=4, default=1.0) or 0.0) for key in ("brightness", "contrast", "saturation", "sharpness")}
    return Adjust(**factors, grayscale=_flag(raw, "grayscale"))


def parse_photo_edit(spec: str) -> PhotoEdit:
    """Read an edit from JSON; every field is optional and an empty object changes nothing."""
    try:
        raw = json.loads(spec)
    except ValueError:
        raise PdfToolError("The edit isn't valid JSON.") from None
    if not isinstance(raw, dict):
        raise PdfToolError("The edit must be a JSON object.")
    rotate = int(_number(raw, "rotate", low=0, high=270, integer=True, default=0) or 0)
    if rotate not in (0, 90, 180, 270):
        raise PdfToolError("rotate must be 0, 90, 180 or 270.")
    crop_raw = _object(raw, "crop")
    resize_raw = _object(raw, "resize")
    adjust_raw = _object(raw, "adjust")
    background = raw.get("background", "#ffffff")
    match = _COLOUR.match(background) if isinstance(background, str) else None
    if not match:
        raise PdfToolError("background must be a colour like #ffffff.")
    hex_colour = match.group(1)
    suffix = raw.get("suffix", "edited")
    if not isinstance(suffix, str) or not _SUFFIX.match(suffix):
        raise PdfToolError("suffix may only have up to 24 lowercase letters, digits and hyphens.")
    return PhotoEdit(
        rotate=rotate,
        flip=_choice(raw, "flip", _FLIPS, "none"),  # type: ignore[arg-type]
        crop=photo_crop_from(crop_raw) if crop_raw is not None else None,
        resize=parse_resize(resize_raw) if resize_raw is not None else None,
        adjust=parse_adjust(adjust_raw) if adjust_raw is not None else None,
        format=_choice(raw, "format", _FORMATS, "keep"),  # type: ignore[arg-type]
        quality=int(_number(raw, "quality", low=1, high=100, integer=True, default=90) or 90),
        background=tuple(int(hex_colour[i : i + 2], 16) for i in (0, 2, 4)),  # type: ignore[arg-type]
        metadata=_choice(raw, "metadata", _METADATA, "keep"),  # type: ignore[arg-type]
        suffix=suffix,
    )


# --- The pipeline ----------------------------------------------------------------


def _px(value: float) -> int:
    """Round half up, as JavaScript's Math.round does, so the app and the backend agree on sizes."""
    return max(1, math.floor(value + 0.5))


def resize_plan(size: tuple[int, int], resize: Resize) -> tuple[tuple[int, int], tuple[int, int]]:
    """The size to scale the photo to, and the size to cut from its middle afterwards.

    The two differ only for `cover`, which scales past the box and trims the
    overhang. The app computes the same plan to show the outcome in advance.
    """
    width, height = size

    def cap(scale: float) -> float:
        return scale if resize.enlarge else min(scale, 1.0)

    if resize.percent is not None:
        sx = sy = cap(resize.percent / 100)
    elif resize.longest is not None:
        sx = sy = cap(resize.longest / max(width, height))
    elif resize.width is not None and resize.height is not None:
        if resize.fit == "stretch":
            sx, sy = cap(resize.width / width), cap(resize.height / height)
        else:
            pick = min if resize.fit == "contain" else max
            sx = sy = cap(pick(resize.width / width, resize.height / height))
    elif resize.width is not None:
        sx = sy = cap(resize.width / width)
    else:
        sx = sy = cap((resize.height or height) / height)
    scaled = (_px(width * sx), _px(height * sy))
    if resize.fit == "cover" and resize.width is not None and resize.height is not None:
        return scaled, (min(scaled[0], resize.width), min(scaled[1], resize.height))
    return scaled, scaled


@dataclass
class _Source:
    """What the photo arrived as, apart from its pixels."""

    kind: str
    """Pillow's format name in lower case: jpeg, png, webp, gif, heif, ..."""
    icc: bytes | None
    icc_for: str | None
    """Which kind of picture the colour profile describes: "RGB", "L" or None for one that won't survive conversion."""
    exif: bytes | None
    """EXIF with the orientation already applied, so without that tag."""
    xmp: bytes | None
    dpi: tuple[int, int] | None


def _open(data: bytes, name: str) -> tuple[Image.Image, _Source]:
    """The photo the right way up, with the first frame of anything animated, and what else came with it."""
    try:
        with Image.open(BytesIO(data)) as opened:
            opened.load()
            kind = (opened.format or "").lower()
            mode = opened.mode
            image = ImageOps.exif_transpose(opened)
    except Image.DecompressionBombError:
        raise PdfToolError(f"{name} has too many pixels for pdfer to open.") from None
    except Exception:  # noqa: BLE001 - PIL raises a mixed bag for data it can't read
        raise PdfToolError(f"{name} isn't an image pdfer can read.") from None
    info = image.info
    dpi = info.get("dpi")
    density = None
    if isinstance(dpi, tuple) and len(dpi) == 2 and all(isinstance(v, (int, float)) and 1 <= v <= 10_000 for v in dpi):
        density = (round(dpi[0]), round(dpi[1]))
    icc = info.get("icc_profile") or None
    icc_for = "RGB" if mode in ("RGB", "RGBA", "P", "PA") else "L" if mode in ("L", "LA", "1", "I", "I;16") else None
    exif = info.get("exif")
    xmp = info.get("xmp")
    return image, _Source(
        kind,
        icc if isinstance(icc, bytes) else None,
        icc_for,
        exif if isinstance(exif, bytes) else None,
        xmp if isinstance(xmp, bytes) else None,
        density,
    )


_TURNS = {90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_90}


def _turn(image: Image.Image, rotate: int, flip: str) -> Image.Image:
    if rotate:
        image = image.transpose(_TURNS[rotate])
    if flip == "horizontal":
        image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    elif flip == "vertical":
        image = image.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    return image


def _cut(image: Image.Image, crop: PhotoCrop) -> Image.Image:
    """The crop. An upright one is cut exactly; a turned one is resampled, with the outside blank."""
    width, height = _px(crop.width), _px(crop.height)
    if width > MAX_SIDE or height > MAX_SIDE:
        raise PdfToolError(f"The crop can be at most {MAX_SIDE} pixels each way.")
    if crop.angle % 360 == 0:
        left = math.floor(crop.cx - crop.width / 2 + 0.5)
        top = math.floor(crop.cy - crop.height / 2 + 0.5)
        box = (max(0, left), max(0, top), min(image.width, left + width), min(image.height, top + height))
        if box[2] <= box[0] or box[3] <= box[1]:
            raise PdfToolError("The crop lies outside the picture.")
        return image.crop(box)
    fill = {"RGB": (255, 255, 255), "RGBA": (0, 0, 0, 0), "L": 255, "LA": (0, 0)}[image.mode]
    return image.transform((width, height), Image.Transform.QUAD, _quad(crop), Image.Resampling.BICUBIC, fillcolor=fill)


def _rescale(image: Image.Image, resize: Resize) -> Image.Image:
    scaled, final = resize_plan(image.size, resize)
    if scaled != image.size:
        image = image.resize(scaled, Image.Resampling.LANCZOS)
    if final != scaled:
        left = (scaled[0] - final[0]) // 2
        top = (scaled[1] - final[1]) // 2
        image = image.crop((left, top, left + final[0], top + final[1]))
    return image


def _enhance(image: Image.Image, adjust: Adjust) -> Image.Image:
    steps: tuple[tuple[float, Callable[[Image.Image], ImageEnhance._Enhance]], ...] = (
        (adjust.brightness, ImageEnhance.Brightness),
        (adjust.contrast, ImageEnhance.Contrast),
        (adjust.saturation, ImageEnhance.Color),
        (adjust.sharpness, ImageEnhance.Sharpness),
    )
    for factor, enhancer in steps:
        if factor != 1.0:
            image = enhancer(image).enhance(factor)
    if adjust.grayscale and image.mode not in ("L", "LA"):
        image = image.convert("LA" if image.mode == "RGBA" else "L")
    return image


def _flatten(image: Image.Image, colour: tuple[int, int, int]) -> Image.Image:
    """Transparency laid over `colour`, as JPEG has none."""
    if image.mode == "LA":
        image = image.convert("RGBA")
    if image.mode == "RGBA":
        flat = Image.new("RGB", image.size, colour)
        flat.paste(image, mask=image.getchannel("A"))
        return flat
    return image


def _location_free(exif: bytes | None) -> bytes | None:
    """The EXIF without its GPS section, with the `Exif\\0\\0` prefix; None when it can't be rebuilt."""
    if not exif:
        return None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            parsed = Image.Exif()
            parsed.load(exif)
            if _GPS not in parsed:
                return exif if exif.startswith(_EXIF_PREFIX) else _EXIF_PREFIX + exif
            del parsed[_GPS]
            return parsed.tobytes()
    except Exception:  # noqa: BLE001 - corrupt EXIF of any shape: better none than the location
        return None


def _mentions_location(xmp: bytes) -> bool:
    return b"GPS" in xmp


def _output_metadata(source: _Source, mode: str) -> tuple[bytes | None, bytes | None]:
    """The EXIF and XMP to write, for a photo that is being re-encoded."""
    if mode == "none":
        return None, None
    exif, xmp = source.exif, source.xmp
    if mode == "no-location":
        exif = _location_free(exif)
        if xmp and _mentions_location(xmp):
            xmp = None
    return exif, xmp


def _encode(image: Image.Image, target: str, edit: PhotoEdit, source: _Source) -> bytes:
    exif, xmp = _output_metadata(source, edit.metadata)
    extra: dict[str, object] = {}
    if source.icc and source.icc_for == ("L" if image.mode in ("L", "LA") else "RGB"):
        extra["icc_profile"] = source.icc
    if source.dpi:
        extra["dpi"] = source.dpi
    if exif:
        extra["exif"] = exif
    if xmp and target != "png":
        extra["xmp"] = xmp
    buf = BytesIO()
    if target == "jpeg":
        _flatten(image, edit.background).save(buf, "JPEG", quality=edit.quality, optimize=True, **extra)
    elif target == "webp":
        colour = image.convert("RGBA" if image.mode in ("RGBA", "LA") else "RGB")
        colour.save(buf, "WEBP", quality=edit.quality, method=6, **extra)
    else:
        _png_ready(image, False).save(buf, "PNG", optimize=True, **extra)
    return buf.getvalue()


def edit_photo(name: str, data: bytes, edit: PhotoEdit) -> EditedPhoto:
    """Apply `edit` to one photo.

    The result is named after the file and the edit's suffix. With `format` kept, JPEGs, PNGs and WebPs stay what they
    are and anything else (GIF, BMP, TIFF, AVIF, HEIC) becomes a PNG when it
    has transparency, else a JPEG. Animated pictures contribute their first
    frame. An edit that changes no pixels and keeps a JPEG, PNG or WebP
    returns the file as it is, or with just its metadata rewritten, so the
    picture is never recompressed; a format that can't be kept is always
    re-encoded.
    """
    image, source = _open(data, name)
    image = _plain_mode(image)
    transparent = image.mode in ("RGBA", "LA")
    target = edit.format if edit.format != "keep" else source.kind if source.kind in _MEDIA else "png" if transparent else "jpeg"
    ext, media = _MEDIA[target]
    stem = name.rsplit(".", 1)[0] if "." in name else name
    out_name = f"{stem or 'photo'}_{edit.suffix}.{ext}" if edit.suffix else f"{stem or 'photo'}.{ext}"

    if edit.format == "keep" and source.kind in _MEDIA and not edit.changes_pixels():
        if edit.metadata == "keep":
            return EditedPhoto(out_name, data, media, image.width, image.height, len(data), len(data))
        stripped = strip_metadata(data, source.kind, edit.metadata)
        if stripped is not None:
            return EditedPhoto(out_name, stripped, media, image.width, image.height, len(data), len(stripped))

    image = _turn(image, edit.rotate, edit.flip)
    if edit.crop:
        image = _cut(image, edit.crop)
    if edit.resize:
        image = _rescale(image, edit.resize)
    if edit.adjust and not edit.adjust.is_identity():
        image = _enhance(image, edit.adjust)
    out = _encode(image, target, edit, source)
    return EditedPhoto(out_name, out, media, image.width, image.height, len(data), len(out))


# --- Metadata without recompression ---------------------------------------------


def _rebuilt_exif(exif: bytes | None, mode: str) -> bytes | None:
    """The EXIF to keep, prefixed: without GPS for `no-location`, only the orientation for `none`."""
    if not exif:
        return None
    if mode == "no-location":
        return _location_free(exif)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            parsed = Image.Exif()
            parsed.load(exif)
            orientation = parsed.get(_ORIENTATION)
            if not isinstance(orientation, int) or orientation not in range(2, 9):
                return None
            minimal = Image.Exif()
            minimal[_ORIENTATION] = orientation
            return minimal.tobytes()
    except Exception:  # noqa: BLE001
        return None


def strip_metadata(data: bytes, kind: str, mode: str) -> bytes | None:
    """The same compressed picture with less metadata, or None when its format can't be rewritten in place.

    `no-location` removes the GPS section of the EXIF and any XMP that
    mentions a location; `none` removes EXIF, XMP, IPTC, comments and
    anything after the picture, keeping the colour profile and, so the
    photo still shows the right way up, its orientation.
    """
    if kind == "jpeg":
        return _strip_jpeg(data, mode)
    if kind == "png":
        return _strip_png(data, mode)
    if kind == "webp":
        return _strip_webp(data, mode)
    return None


_XMP_APP1 = (b"http://ns.adobe.com/xap/1.0/\x00", b"http://ns.adobe.com/xmp/extension/\x00")


def _jpeg_segments(data: bytes) -> tuple[list[tuple[int, bytes]], bytes] | None:
    """The segments before the scan as (marker, whole segment), and everything from the scan on."""
    if data[:2] != b"\xff\xd8":
        return None
    segments: list[tuple[int, bytes]] = []
    i, n = 2, len(data)
    while i < n:
        if data[i] != 0xFF:
            return None
        start = i
        while i < n and data[i] == 0xFF:
            i += 1
        if i >= n:
            return None
        marker = data[i]
        i += 1
        if marker in (0xDA, 0xD9):
            return segments, b"\xff" + data[i - 1 :]
        if 0xD0 <= marker <= 0xD7 or marker == 0x01:
            segments.append((marker, data[start:i]))
            continue
        if i + 2 > n:
            return None
        (length,) = struct.unpack(">H", data[i : i + 2])
        if length < 2 or i + length > n:
            return None
        segments.append((marker, b"\xff" + bytes([marker]) + data[i : i + length]))
        i += length
    return None


def _jpeg_segment(marker: int, payload: bytes) -> bytes | None:
    if len(payload) + 2 > 0xFFFF:
        return None
    return b"\xff" + bytes([marker]) + struct.pack(">H", len(payload) + 2) + payload


def _strip_jpeg(data: bytes, mode: str) -> bytes | None:
    parts = _jpeg_segments(data)
    if parts is None:
        return None
    segments, rest = parts
    payloads = [(marker, segment[4:]) for marker, segment in segments]
    exif = next((payload for marker, payload in payloads if marker == 0xE1 and payload.startswith(_EXIF_PREFIX)), None)
    new_exif = _rebuilt_exif(exif, mode)
    replacement = _jpeg_segment(0xE1, new_exif) if new_exif else None
    drop_xmp = mode == "none" or any(
        marker == 0xE1 and payload.startswith(_XMP_APP1) and _mentions_location(payload) for marker, payload in payloads
    )
    out = [b"\xff\xd8"]
    for (marker, segment), (_, payload) in zip(segments, payloads, strict=True):
        if marker == 0xE1 and payload.startswith(_EXIF_PREFIX):
            if replacement:
                out.append(replacement)
                replacement = None
            continue
        if marker == 0xE1 and payload.startswith(_XMP_APP1):
            if drop_xmp:
                continue
        elif mode == "none" and marker == 0xFE:
            continue
        elif mode == "none" and 0xE1 <= marker <= 0xEF and marker != 0xEE:
            if not (marker == 0xE2 and payload.startswith(b"ICC_PROFILE\x00")):
                continue
        out.append(segment)
    if mode == "none":
        # Nothing after the picture's own end: no trailing pictures, videos or notes.
        end = rest.find(b"\xff\xd9")
        if end != -1:
            rest = rest[: end + 2]
    out.append(rest)
    return b"".join(out)


_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_PNG_TEXT = (b"tEXt", b"zTXt", b"iTXt")
_PNG_XMP = b"XML:com.adobe.xmp\x00"


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def _strip_png(data: bytes, mode: str) -> bytes | None:
    if not data.startswith(_PNG_SIGNATURE):
        return None
    chunks: list[tuple[bytes, bytes, bytes]] = []
    i = 8
    while i + 12 <= len(data):
        (length,) = struct.unpack(">I", data[i : i + 4])
        kind = data[i + 4 : i + 8]
        end = i + 12 + length
        if end > len(data):
            return None
        chunks.append((kind, data[i + 8 : i + 8 + length], data[i:end]))
        i = end
        if kind == b"IEND":
            break
    if not chunks or chunks[-1][0] != b"IEND":
        return None
    exif = next((payload for kind, payload, _ in chunks if kind == b"eXIf"), None)
    new_exif = _rebuilt_exif(exif, mode)
    replacement = _png_chunk(b"eXIf", new_exif[len(_EXIF_PREFIX) :]) if new_exif else None
    drop_xmp = mode == "none" or any(
        kind == b"iTXt" and payload.startswith(_PNG_XMP) and _mentions_location(payload) for kind, payload, _ in chunks
    )
    out = [_PNG_SIGNATURE]
    for kind, payload, raw in chunks:
        if kind == b"eXIf":
            if replacement:
                out.append(replacement)
                replacement = None
            continue
        if kind == b"iTXt" and payload.startswith(_PNG_XMP):
            if drop_xmp:
                continue
        elif mode == "none" and kind in (*_PNG_TEXT, b"tIME"):
            continue
        out.append(raw)
    return b"".join(out)


def _webp_chunk(fourcc: bytes, payload: bytes) -> bytes:
    return fourcc + struct.pack("<I", len(payload)) + payload + (b"\x00" if len(payload) % 2 else b"")


def _strip_webp(data: bytes, mode: str) -> bytes | None:
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return None
    chunks: list[tuple[bytes, bytes]] = []
    i = 12
    while i + 8 <= len(data):
        fourcc = data[i : i + 4]
        (size,) = struct.unpack("<I", data[i + 4 : i + 8])
        if i + 8 + size > len(data):
            return None
        chunks.append((fourcc, data[i + 8 : i + 8 + size]))
        i += 8 + size + (size % 2)
    if not chunks:
        return None
    if chunks[0][0] != b"VP8X":
        return data  # a simple WebP has no room for metadata
    exif = next((payload for fourcc, payload in chunks if fourcc == b"EXIF"), None)
    new_exif = _rebuilt_exif(exif, mode)
    drop_xmp = mode == "none" or any(fourcc == b"XMP " and _mentions_location(payload) for fourcc, payload in chunks)
    keeps_xmp = not drop_xmp and any(fourcc == b"XMP " for fourcc, _ in chunks)
    out = []
    inserted = False
    for fourcc, payload in chunks:
        if fourcc == b"VP8X" and payload:
            flags = payload[0] & ~0x0C
            flags |= 0x08 if new_exif else 0
            flags |= 0x04 if keeps_xmp else 0
            payload = bytes([flags]) + payload[1:]
        elif fourcc == b"EXIF":
            if new_exif and not inserted:
                out.append(_webp_chunk(fourcc, new_exif[len(_EXIF_PREFIX) :]))
                inserted = True
            continue
        elif fourcc == b"XMP " and drop_xmp:
            continue
        out.append(_webp_chunk(fourcc, payload))
    body = b"WEBP" + b"".join(out)
    return b"RIFF" + struct.pack("<I", len(body)) + body


# --- What a photo says about itself -----------------------------------------------


def _text(value: object) -> str | None:
    if isinstance(value, bytes):
        value = value.decode("utf-8", "ignore")
    if not isinstance(value, str):
        return None
    cleaned = " ".join(value.replace("\x00", " ").split())
    return cleaned[:200] or None


def _float(value: object) -> float | None:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    return number if math.isfinite(number) else None


def _date(value: object) -> str | None:
    text = _text(value)
    if not text:
        return None
    match = re.match(r"^(\d{4}):(\d{2}):(\d{2})( \d{2}:\d{2}:\d{2})?", text)
    if not match or match.group(1) == "0000":
        return None
    return f"{match.group(1)}-{match.group(2)}-{match.group(3)}{match.group(4) or ''}"


def _exposure_time(value: object) -> str | None:
    seconds = _float(value)
    if seconds is None or seconds <= 0:
        return None
    if seconds < 1:
        return f"1/{round(1 / seconds)} s"
    return f"{seconds:g} s"


def _aperture(value: object) -> str | None:
    number = _float(value)
    return f"f/{number:g}" if number and number > 0 else None


def _millimetres(value: object) -> str | None:
    number = _float(value)
    return f"{round(number, 1):g} mm" if number and number > 0 else None


def _iso(value: object) -> int | None:
    if isinstance(value, (tuple, list)) and value:
        value = value[0]
    return int(value) if isinstance(value, int) and not isinstance(value, bool) and 0 < value < 10_000_000 else None


def _coordinate(value: object, ref: object) -> float | None:
    try:
        degrees, minutes, seconds = (float(v) for v in value)  # type: ignore[union-attr]
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    total = degrees + minutes / 60 + seconds / 3600
    if not math.isfinite(total) or total > 180:
        return None
    direction = (_text(ref) or "").upper()
    return round(-total if direction.startswith(("S", "W")) else total, 6)


def _location(gps: dict[int, object]) -> dict[str, float | None] | None:
    latitude = _coordinate(gps.get(2), gps.get(1))
    longitude = _coordinate(gps.get(4), gps.get(3))
    if latitude is None and longitude is None:
        return None
    altitude = _float(gps.get(6))
    below = gps.get(5) in (1, b"\x01")
    return {
        "latitude": latitude,
        "longitude": longitude,
        "altitude": round(-altitude if below else altitude, 1) if altitude is not None else None,
    }


def _mode_label(mode: str, transparent: bool) -> str:
    base = {
        "1": "Black and white", "L": "Grayscale", "LA": "Grayscale", "P": "Palette", "PA": "Palette",
        "RGB": "Colour", "RGBA": "Colour", "CMYK": "CMYK colour", "YCbCr": "Colour", "LAB": "Lab colour", "HSV": "Colour",
        "I": "Grayscale (16-bit)", "I;16": "Grayscale (16-bit)", "F": "Grayscale (float)",
    }.get(mode, mode)
    return f"{base} with transparency" if transparent else base


def read_photo_info(name: str, data: bytes) -> dict[str, object]:
    """What a photo is and what it records: size, camera, exposure, location and which metadata it carries."""
    try:
        with Image.open(BytesIO(data)) as image:
            fmt = image.format or "unknown"
            mode = image.mode
            width, height = image.size
            info = dict(image.info)
            frames = getattr(image, "n_frames", 1)
            exif = image.getexif()
            ifd0 = dict(exif)
            try:
                photo_ifd = dict(exif.get_ifd(ExifTags.IFD.Exif))
            except Exception:  # noqa: BLE001
                photo_ifd = {}
            try:
                gps = dict(exif.get_ifd(_GPS))
            except Exception:  # noqa: BLE001
                gps = {}
    except Image.DecompressionBombError:
        raise PdfToolError(f"{name} has too many pixels for pdfer to open.") from None
    except Exception:  # noqa: BLE001
        raise PdfToolError(f"{name} isn't an image pdfer can read.") from None

    if fmt == "HEIF" and _heif_media_type is not None:
        # The container is HEIF either way; the HEVC-coded kind phones take is known as HEIC.
        fmt = "HEIC" if _heif_media_type(data).startswith("image/heic") else "HEIF"
    orientation = ifd0.get(_ORIENTATION)
    if not isinstance(orientation, int) or orientation not in range(1, 9):
        orientation = None
    if orientation in (5, 6, 7, 8):
        width, height = height, width
    dpi = info.get("dpi")
    density = None
    if isinstance(dpi, tuple) and len(dpi) == 2 and all(isinstance(v, (int, float)) and 1 <= v <= 10_000 for v in dpi):
        density = [round(dpi[0]), round(dpi[1])]
    transparent = mode in ("RGBA", "LA", "PA") or "transparency" in info
    return {
        "name": name,
        "bytes": len(data),
        "format": fmt,
        "media_type": Image.MIME.get(fmt, f"image/{fmt.lower()}"),
        "width": width,
        "height": height,
        "mode": _mode_label(mode, transparent),
        "transparency": transparent,
        "frames": frames if isinstance(frames, int) and frames > 0 else 1,
        "dpi": density,
        "orientation": orientation,
        "camera": {
            "make": _text(ifd0.get(271)),
            "model": _text(ifd0.get(272)),
            "lens": _text(photo_ifd.get(42036)),
            "software": _text(ifd0.get(305)),
        },
        "taken": _date(photo_ifd.get(36867)) or _date(photo_ifd.get(36868)) or _date(ifd0.get(306)),
        "exposure": {
            "time": _exposure_time(photo_ifd.get(33434)),
            "aperture": _aperture(photo_ifd.get(33437)),
            "iso": _iso(photo_ifd.get(34855)),
            "focal_length": _millimetres(photo_ifd.get(37386)),
            "focal_length_35mm": _millimetres(photo_ifd.get(41989)),
        },
        "gps": _location(gps),
        "author": {
            "artist": _text(ifd0.get(315)),
            "copyright": _text(ifd0.get(33432)),
            "description": _text(ifd0.get(270)),
        },
        "metadata": {
            "exif_tags": len(ifd0) + len(photo_ifd) + len(gps),
            "xmp": "xmp" in info,
            "icc_profile": "icc_profile" in info,
            "iptc": "photoshop" in info,
        },
    }
