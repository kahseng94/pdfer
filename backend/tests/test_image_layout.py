from dataclasses import replace
from io import BytesIO

import pikepdf
import pytest
from conftest import make_image
from fastapi.testclient import TestClient
from PIL import Image

from pdfer import core
from pdfer.api import app


def pdf_images(container):
    found = []
    for obj in container.Resources.get("/XObject", {}).values():
        if obj.Subtype == pikepdf.Name.Form:
            found.extend(pdf_images(obj))
        elif obj.Subtype == pikepdf.Name.Image:
            found.append(obj)
    return found


@pytest.mark.parametrize("paper, expected", [("a4", (210 * 72 / 25.4, 297 * 72 / 25.4)), ("letter", (612, 792))])
@pytest.mark.parametrize("orientation", ["portrait", "landscape"])
@pytest.mark.parametrize("fit", ["contain", "cover", "stretch"])
def test_fixed_paper_layouts_use_the_exact_page_size_and_clip_at_the_margins(paper, expected, orientation, fit):
    layout = core.ImagePdfLayout(paper=paper, orientation=orientation, margin_mm=10, fit=fit)
    output = core.images_to_pdf([("wide.png", make_image(600, 300)), ("tall.png", make_image(300, 600))], layout)
    width, height = expected if orientation == "portrait" else expected[::-1]
    margin = 10 * 72 / 25.4
    with pikepdf.open(BytesIO(output)) as pdf:
        assert len(pdf.pages) == 2
        for page, (iw, ih) in zip(pdf.pages, [(600, 300), (300, 600)]):
            assert list(map(float, page.mediabox)) == pytest.approx([0, 0, width, height], abs=1e-4)
            assert page.rotation == 0
            instructions = [(list(args), str(op)) for args, op in pikepdf.parse_content_stream(page)]
            rectangles = [list(map(float, args)) for args, op in instructions if op == "re"]
            assert rectangles[-1] == pytest.approx([margin, margin, width - 2 * margin, height - 2 * margin], abs=1e-4)
            assert [op for _, op in instructions].index("W") < [op for _, op in instructions].index("Do")
            matrix = next(list(map(float, args)) for args, op in instructions if op == "cm")
            sx, _, _, sy, x, y = matrix
            draw_width, draw_height = sx * iw, sy * ih
            assert x + draw_width / 2 == pytest.approx(width / 2, abs=0.001)
            assert y + draw_height / 2 == pytest.approx(height / 2, abs=0.001)
            if fit == "stretch":
                assert draw_width == pytest.approx(width - 2 * margin, abs=0.001)
                assert draw_height == pytest.approx(height - 2 * margin, abs=0.001)
            else:
                assert sx == sy
                if fit == "contain":
                    assert x >= margin - 0.001 and y >= margin - 0.001
                    assert min(abs(x - margin), abs(y - margin)) < 0.001
                else:
                    assert x <= margin + 0.001 and y <= margin + 0.001
                    assert min(abs(x - margin), abs(y - margin)) < 0.001
            images = pdf_images(page)
            assert len(images) == 1
            assert (images[0].Width, images[0].Height) == (iw, ih)


@pytest.mark.parametrize("orientation", range(1, 9))
def test_every_exif_orientation_keeps_jpeg_bytes_and_fixed_page_orientation(orientation):
    exif = Image.Exif()
    exif[0x0112] = orientation
    source = make_image(200, 100, "JPEG", exif=exif)
    output = core.images_to_pdf([("phone.jpg", source)], core.ImagePdfLayout(paper="letter", orientation="portrait"))
    with pikepdf.open(BytesIO(output)) as pdf:
        page = pdf.pages[0]
        assert list(page.mediabox) == [0, 0, 612, 792]
        assert page.rotation == 0
        image = pdf_images(page)[0]
        assert image.Filter == pikepdf.Name.DCTDecode
        assert image.read_raw_bytes() == source
        form = next(iter(page.Resources.XObject.values()))
        matrix = pikepdf.Matrix(*(float(v) for v in form.get("/Matrix", [1, 0, 0, 1, 0, 0])))
        box = matrix.transform(pikepdf.Rectangle(form.BBox))
        assert box.width / box.height == pytest.approx(0.5 if orientation in (5, 6, 7, 8) else 2)


def test_fixed_paper_fitting_uses_pixel_aspect_ratio_even_with_unequal_dpi():
    source = make_image(300, 300, "JPEG", dpi=(300, 100))
    output = core.images_to_pdf([("square.jpg", source)], core.ImagePdfLayout(paper="a4"))
    with pikepdf.open(BytesIO(output)) as pdf:
        form = next(iter(pdf.pages[0].Resources.XObject.values()))
        assert float(form.BBox[2]) == float(form.BBox[3])


def test_transparent_png_keeps_its_soft_mask_and_the_page_has_a_white_background():
    output = core.images_to_pdf([("alpha.png", make_image(200, 100, mode="RGBA"))], core.ImagePdfLayout(paper="letter", fit="cover"))
    with pikepdf.open(BytesIO(output)) as pdf:
        page = pdf.pages[0]
        image = pdf_images(page)[0]
        assert image.SMask.Width == 200
        assert image.SMask.Height == 100
        instructions = [(list(args), str(op)) for args, op in pikepdf.parse_content_stream(page)]
        assert next(args for args, op in instructions if op == "rg") == [1, 1, 1]
        assert [op for _, op in instructions].index("f") < [op for _, op in instructions].index("Do")


def test_image_size_mode_keeps_original_resolution_and_ignores_paper_layout_controls():
    source = make_image(300, 600, "JPEG", dpi=(300, 300))
    output = core.images_to_pdf([("original.jpg", source)], core.ImagePdfLayout(paper="image", orientation="landscape", margin_mm=100, fit="stretch"))
    with pikepdf.open(BytesIO(output)) as pdf:
        assert list(pdf.pages[0].mediabox) == [0, 0, 72, 144]


def test_an_animated_png_still_produces_one_page_per_uploaded_image():
    source = BytesIO()
    Image.new("RGB", (200, 100), "red").save(source, "PNG", save_all=True, append_images=[Image.new("RGB", (200, 100), "blue")], duration=100)
    for layout in [None, core.ImagePdfLayout(paper="a4")]:
        output = core.images_to_pdf([("animated.png", source.getvalue())], layout)
        with pikepdf.open(BytesIO(output)) as pdf:
            assert len(pdf.pages) == 1


@pytest.mark.parametrize("margin", [0, 0.5, 100])
def test_valid_margin_extremes(margin):
    output = core.images_to_pdf([("one.png", make_image(200, 100))], core.ImagePdfLayout(paper="a4", margin_mm=margin, fit="cover"))
    with pikepdf.open(BytesIO(output)) as pdf:
        assert len(pdf.pages) == 1


@pytest.mark.parametrize("size", [(1, 1), (1, 200), (200, 1)])
@pytest.mark.parametrize("paper", ["image", "a4"])
def test_tiny_images_can_be_embedded_without_reencoding_or_invalid_page_errors(size, paper):
    output = core.images_to_pdf([("tiny.png", make_image(*size))], core.ImagePdfLayout(paper=paper))
    with pikepdf.open(BytesIO(output)) as pdf:
        assert len(pdf.pages) == 1
        image = pdf_images(pdf.pages[0])[0]
        assert (image.Width, image.Height) == size


@pytest.mark.parametrize("patch", [{"paper": "a3"}, {"orientation": "automatic"}, {"fit": "unknown"}, {"margin_mm": -1}, {"margin_mm": 101}, {"margin_mm": float("nan")}, {"margin_mm": float("inf")}, {"margin_mm": True}])
def test_invalid_layouts_are_rejected(patch):
    with pytest.raises(core.PdfToolError):
        core.images_to_pdf([("one.png", make_image(200, 100))], replace(core.ImagePdfLayout(paper="a4"), **patch))


def test_layout_api_returns_a_preview_pdf_in_upload_order():
    client = TestClient(app)
    response = client.post("/api/images", files=[("files", ("wide.png", make_image(600, 300), "image/png")), ("files", ("tall.jpg", make_image(300, 600, "JPEG"), "image/jpeg"))],
                           data={"paper": "letter", "orientation": "landscape", "margin_mm": "12.5", "fit": "cover"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["cache-control"] == "no-store"
    with pikepdf.open(BytesIO(response.content)) as pdf:
        assert [list(page.mediabox) for page in pdf.pages] == [[0, 0, 792, 612], [0, 0, 792, 612]]
        assert [(pdf_images(page)[0].Width, pdf_images(page)[0].Height) for page in pdf.pages] == [(600, 300), (300, 600)]


@pytest.mark.parametrize("fields, status", [({"paper": "a3"}, 422), ({"orientation": "auto"}, 422), ({"fit": "bad"}, 422), ({"margin_mm": "-1"}, 400), ({"margin_mm": "NaN"}, 400), ({"margin_mm": "101"}, 400)])
def test_api_validates_layout_fields(fields, status):
    response = TestClient(app).post("/api/images", files=[("files", ("one.png", make_image(200, 100), "image/png"))], data={"paper": "a4", **fields})
    assert response.status_code == status
