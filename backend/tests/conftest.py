import zlib
from decimal import Decimal
from io import BytesIO

import pikepdf
import pytest
from PIL import Image


def make_pdf(widths: list[int], password: str | None = None, rotations: list[int] | None = None) -> bytes:
    """Build a PDF whose page widths identify each page in assertions."""
    with pikepdf.new() as pdf:
        for i, w in enumerate(widths):
            page = pdf.add_blank_page(page_size=(w, 200))
            if rotations and rotations[i]:
                page.Rotate = rotations[i]
        buf = BytesIO()
        encryption = pikepdf.Encryption(owner=password, user=password) if password else False
        pdf.save(buf, encryption=encryption)
        return buf.getvalue()


def make_image(width: int, height: int, fmt: str = "PNG", mode: str = "RGB", **save) -> bytes:
    """A flat-colour image; at img2pdf's default 96 dpi, 96 px becomes a 72 pt page edge."""
    buf = BytesIO()
    Image.new(mode, (width, height), (200, 30, 60, 128) if mode == "RGBA" else (200, 30, 60)).save(buf, fmt, **save)
    return buf.getvalue()


def widths(data: bytes) -> list[int]:
    with pikepdf.open(BytesIO(data)) as pdf:
        return [int(p.mediabox[2]) for p in pdf.pages]


def rotations(data: bytes) -> list[int]:
    with pikepdf.open(BytesIO(data)) as pdf:
        return [int(p.get("/Rotate", 0)) for p in pdf.pages]


@pytest.fixture
def ten_pages() -> bytes:
    return make_pdf([101, 102, 103, 104, 105, 106, 107, 108, 109, 110])


def make_image_pdf(side: int = 2500, nested: bool = False, smask: bool = False) -> bytes:
    """Build a one-page PDF with a square RGB image of random noise, stored as Flate.

    Noise doesn't deflate, so the file is roughly side*side*3 bytes until the
    image is re-encoded. With `nested` the image sits inside a form XObject;
    with `smask` it carries a soft mask, which compression must leave alone.
    """
    noise = Image.merge("RGB", [Image.effect_noise((side, side), 80) for _ in range(3)])
    with pikepdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(612, 792))
        image = pdf.make_stream(
            zlib.compress(noise.tobytes(), 1),
            Type=pikepdf.Name.XObject,
            Subtype=pikepdf.Name.Image,
            Width=side,
            Height=side,
            ColorSpace=pikepdf.Name.DeviceRGB,
            BitsPerComponent=8,
            Filter=pikepdf.Name.FlateDecode,
        )
        if smask:
            image.SMask = pdf.make_stream(
                b"\xff" * (side * side),
                Type=pikepdf.Name.XObject,
                Subtype=pikepdf.Name.Image,
                Width=side,
                Height=side,
                ColorSpace=pikepdf.Name.DeviceGray,
                BitsPerComponent=8,
            )
        if nested:
            form = pdf.make_stream(
                b"q 1 0 0 1 0 0 cm /Im0 Do Q",
                Type=pikepdf.Name.XObject,
                Subtype=pikepdf.Name.Form,
                BBox=[0, 0, 1, 1],
                Resources=pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=image)),
            )
            page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Fm0=form))
            page.Contents = pdf.make_stream(b"q 612 0 0 792 0 0 cm /Fm0 Do Q")
        else:
            page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=image))
            page.Contents = pdf.make_stream(b"q 612 0 0 792 0 0 cm /Im0 Do Q")
        buf = BytesIO()
        pdf.save(buf)
        return buf.getvalue()


ImageInfo = tuple[str, int, int, str]
"""(filter, width, height, colour space) of an image XObject."""


def images(data: bytes) -> list[ImageInfo]:
    """Describe every image XObject reachable from the pages, including those inside forms."""
    found: list[ImageInfo] = []

    def walk(container: pikepdf.Object) -> None:
        for obj in container.Resources.get("/XObject", pikepdf.Dictionary()).values():
            if obj.get("/Subtype") == pikepdf.Name.Form:
                walk(obj)
            elif obj.get("/Subtype") == pikepdf.Name.Image:
                found.append((str(obj.get("/Filter")), int(obj.Width), int(obj.Height), str(obj.ColorSpace)))

    with pikepdf.open(BytesIO(data)) as pdf:
        for page in pdf.pages:
            walk(page.obj)
    return found


@pytest.fixture(scope="session")
def image_pdf() -> bytes:
    return make_image_pdf()


def instructions(data: bytes, page: int = 0) -> list[tuple[list[object], str]]:
    """The page's content as (operands, operator) pairs with plain Python values."""

    def plain(obj: object) -> object:
        if isinstance(obj, (int, float, Decimal)):
            return float(obj)
        return str(obj)

    with pikepdf.open(BytesIO(data)) as pdf:
        return [([plain(o) for o in ops], str(op)) for ops, op in pikepdf.parse_content_stream(pdf.pages[page])]


def xobjects(data: bytes, page: int = 0) -> list[tuple[str, int, int, str, bool]]:
    """(filter, width, height, colour space, has soft mask) for each image XObject on the page."""
    with pikepdf.open(BytesIO(data)) as pdf:
        found = pdf.pages[page].Resources.get("/XObject", pikepdf.Dictionary())
        return [
            (str(v.Filter), int(v.Width), int(v.Height), str(v.ColorSpace), "/SMask" in v)
            for v in found.values()
            if v.get("/Subtype") == pikepdf.Name.Image
        ]
