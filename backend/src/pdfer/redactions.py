"""Build an image-only PDF from already-redacted pixels. No original PDF objects are copied."""
import json
import math
import zlib
from io import BytesIO

import pikepdf
from PIL import Image

from pdfer import core

MAX_IMAGE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024


def rebuild(images: list[bytes], spec: str, password="") -> bytes:
    try: sizes = json.loads(spec)
    except ValueError: raise core.PdfToolError("Page sizes must be valid JSON.") from None
    if not images or len(images) > 1000 or not isinstance(sizes, list) or len(sizes) != len(images):
        raise core.PdfToolError("Provide one rendered image and size for each page, up to 1000 pages.")
    if sum(map(len, images)) > MAX_TOTAL_BYTES or any(len(data) > MAX_IMAGE_BYTES for data in images):
        raise core.PdfToolError("The rendered pages are too large. Use a lower resolution or split the PDF first.")
    if "\0" in password or len(password.encode("utf-8")) > 127:
        raise core.PdfToolError("The output password must be at most 127 UTF-8 bytes without null characters.")
    pixels = 0
    encoded_bytes = 0
    with pikepdf.new() as pdf:
        for number, (data, size) in enumerate(zip(images, sizes), 1):
            if not isinstance(size, dict) or any(type(size.get(key)) not in (int, float) or not 1 <= size[key] <= 100_000 or not math.isfinite(size[key]) for key in ("width", "height")):
                raise core.PdfToolError(f"Page {number} has an invalid physical size.")
            try:
                with Image.open(BytesIO(data)) as source:
                    if source.format != "PNG" or source.width * source.height > 32_000_000:
                        raise core.PdfToolError(f"Page {number} must be a PNG with at most 32 million pixels.")
                    pixels += source.width * source.height
                    if pixels > 250_000_000:
                        raise core.PdfToolError("This document has too many rendered pixels. Use a lower resolution or split it first.")
                    # Decode pixels and reconstruct the stream, discarding PNG metadata too.
                    rgba = source.convert("RGBA")
                    image = Image.new("RGB", rgba.size, "white")
                    image.paste(rgba, mask=rgba.getchannel("A"))
                    encoded = zlib.compress(image.tobytes())
                    encoded_bytes += len(encoded)
                    if encoded_bytes > MAX_TOTAL_BYTES:
                        raise core.PdfToolError("The redacted PDF is too large. Use a lower resolution or split it first.")
                    width, height = image.size
            except core.PdfToolError: raise
            except Exception: raise core.PdfToolError(f"Rendered page {number} could not be read.") from None
            unit = max(1., size["width"] / 14400, size["height"] / 14400)
            page_width, page_height = size["width"] / unit, size["height"] / unit
            # Very small pages are legal even though add_blank_page imposes a 3 pt minimum.
            page = pdf.add_blank_page(page_size=(max(3, page_width), max(3, page_height)))
            page.MediaBox = [0, 0, page_width, page_height]
            if unit != 1: page.UserUnit = unit
            picture = pdf.make_stream(encoded, Type=pikepdf.Name.XObject, Subtype=pikepdf.Name.Image,
                                      Width=width, Height=height, BitsPerComponent=8, ColorSpace=pikepdf.Name.DeviceRGB, Filter=pikepdf.Name.FlateDecode)
            page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(PageImage=picture))
            page.Contents = pdf.make_stream(f"q {page_width:.9f} 0 0 {page_height:.9f} 0 0 cm /PageImage Do Q".encode())
        return core._save(pdf, password, min_version="1.6")
