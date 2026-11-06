from io import BytesIO
from random import Random

import pikepdf
import pypdfium2 as pdfium
import pytest
from PIL import Image, ImageCms

from pdfer import core


def transparent_pdf(*, grayscale=False, shared=False, complex_mask=False, noise=False):
    """A coloured rectangle over blue paper with transparent/half/opaque bands.

    The image and alpha are deliberately stored raw, so tests do not depend
    on platform-specific JPEG size differences to choose a smaller candidate.
    """
    size = (120, 120)
    colour = Image.new("L" if grayscale else "RGB", size, 150 if grayscale else (220, 60, 30))
    if noise:
        colour = Image.frombytes(colour.mode, size, Random(7).randbytes(120 * 120 * (1 if grayscale else 3)))
    alpha = Image.new("L", size)
    alpha.paste(128, (40, 0, 80, 120))
    alpha.paste(255, (80, 0, 120, 120))
    with pikepdf.new() as pdf:
        mask = pdf.make_stream(alpha.tobytes(), Type=pikepdf.Name.XObject, Subtype=pikepdf.Name.Image,
                               Width=120, Height=120, BitsPerComponent=8, ColorSpace=pikepdf.Name.DeviceGray)
        if complex_mask:
            mask.Matte = [1] if grayscale else [1, 1, 1]
        profile_bytes = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
        profile = pdf.make_stream(profile_bytes, N=3, Alternate=pikepdf.Name.DeviceRGB)
        space = pikepdf.Name.DeviceGray if grayscale else pikepdf.Array([pikepdf.Name.ICCBased, profile])
        image = pdf.make_stream(colour.tobytes(), Type=pikepdf.Name.XObject, Subtype=pikepdf.Name.Image,
                                Width=120, Height=120, BitsPerComponent=8, ColorSpace=space, SMask=mask)
        page = pdf.add_blank_page(page_size=size)
        page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im=image))
        page.Contents = pdf.make_stream(b"0 0 1 rg 0 0 120 120 re f q 120 0 0 120 0 0 cm /Im Do Q")
        if shared:
            # A CMYK image cannot take the new path and must retain its shared
            # mask unmodified. Also expose the mask as a normal page resource.
            other = pdf.make_stream(bytes([0, 200, 100, 0]) * 120 * 120, Type=pikepdf.Name.XObject,
                                    Subtype=pikepdf.Name.Image, Width=120, Height=120, BitsPerComponent=8,
                                    ColorSpace=pikepdf.Name.DeviceCMYK, SMask=mask)
            page.Resources.XObject.Other = other
            page.Resources.XObject.Alpha = mask
            page.Contents = pdf.make_stream(page.Contents.read_bytes() + b" q 1 0 0 1 0 0 cm /Other Do /Alpha Do Q")
        output = BytesIO()
        pdf.save(output, compress_streams=False)
        return output.getvalue()


@pytest.mark.parametrize("grayscale", [False, True])
def test_target_reencodes_soft_mask_colour_without_flattening_or_losing_profile(grayscale):
    source = transparent_pdf(grayscale=grayscale, noise=True)
    out = core.compress(source, "balanced", max_bytes=10_000)
    assert len(out) <= 10_000 < len(source)
    with pikepdf.open(BytesIO(source)) as original, pikepdf.open(BytesIO(out)) as result:
        before, after = original.pages[0].Resources.XObject.Im, result.pages[0].Resources.XObject.Im
        assert after.Filter == pikepdf.Name.DCTDecode
        assert after.Width == after.SMask.Width == 120
        assert after.Height == after.SMask.Height == 120
        assert after.SMask.read_bytes() == before.SMask.read_bytes()
        assert after.SMask.Filter == pikepdf.Name.FlateDecode  # never lossy JPEG
        assert result.pages[0].Contents.read_bytes() == original.pages[0].Contents.read_bytes()
        if not grayscale:
            assert after.ColorSpace[0] == pikepdf.Name.ICCBased
            assert after.ColorSpace[1].read_bytes() == before.ColorSpace[1].read_bytes()


@pytest.mark.parametrize("grayscale", [False, True])
def test_resized_mask_and_colour_stay_aligned_and_render_transparency(grayscale):
    source = transparent_pdf(grayscale=grayscale)
    out = core._compress_candidate(source, "transparent.pdf", "", (60, 75), None, soft_masks=True)
    with pikepdf.open(BytesIO(out)) as pdf:
        image = pdf.pages[0].Resources.XObject.Im
        assert image.Width == image.SMask.Width == 60
        assert image.Height == image.SMask.Height == 60
        alpha = pikepdf.PdfImage(image.SMask).as_pil_image()
        assert [alpha.getpixel((x, 30)) for x in (5, 30, 55)] == [0, 128, 255]
    with pdfium.PdfDocument(source) as before_doc, pdfium.PdfDocument(out) as after_doc:
        before = before_doc[0].render(scale=1).to_pil().convert("RGB")
        after = after_doc[0].render(scale=1).to_pil().convert("RGB")
        # Transparent pixels must show blue paper, with partial alpha blending
        # in the middle band; white/black flattening cannot pass this check.
        for x in (10, 60, 110):
            assert max(abs(a - b) for a, b in zip(before.getpixel((x, 60)), after.getpixel((x, 60)))) <= 5


def test_resizing_clones_shared_alpha_and_never_jpeg_encodes_mask_resources():
    source = transparent_pdf(shared=True)
    out = core._compress_candidate(source, "shared.pdf", "", (60, 75), None, soft_masks=True)
    with pikepdf.open(BytesIO(source)) as original, pikepdf.open(BytesIO(out)) as result:
        before, after = original.pages[0].Resources.XObject, result.pages[0].Resources.XObject
        assert after.Im.Width == after.Im.SMask.Width == 60
        assert after.Other.Width == after.Other.SMask.Width == 120
        assert after.Other.SMask.objgen == after.Alpha.objgen
        assert after.Im.SMask.objgen != after.Alpha.objgen
        assert after.Alpha.read_bytes() == before.Alpha.read_bytes()
        assert after.Alpha.Filter == pikepdf.Name.FlateDecode


def test_complex_masks_and_preset_mode_remain_unchanged():
    for source, target in [(transparent_pdf(complex_mask=True), 1000), (transparent_pdf(), None)]:
        out = core.compress(source, "strong", max_bytes=target)
        with pikepdf.open(BytesIO(source)) as original, pikepdf.open(BytesIO(out)) as result:
            before, after = original.pages[0].Resources.XObject.Im, result.pages[0].Resources.XObject.Im
            assert after.read_bytes() == before.read_bytes()
            assert after.SMask.read_bytes() == before.SMask.read_bytes()
            assert after.Width == before.Width
