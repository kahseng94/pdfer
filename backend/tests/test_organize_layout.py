import json
from io import BytesIO

import pikepdf
import pytest
from fastapi.testclient import TestClient

from pdfer import core
from pdfer.api import app

PT = 72 / 25.4


def document(rotation=0, unit=1, password="", annotations=False):
    with pikepdf.new() as pdf:
        for index in range(2):
            page = pdf.add_blank_page(page_size=(500, 700))
            page.CropBox = [20, 30, 420, 630]
            page.Rotate = rotation
            page.UserUnit = unit
            page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=pdf.make_indirect(pikepdf.Dictionary(
                Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))))
            page.Contents = pdf.make_stream(f"BT /F1 20 Tf 80 400 Td (Page {index + 1}) Tj ET".encode())
            if annotations:
                page.Annots = pikepdf.Array([pdf.make_indirect(pikepdf.Dictionary(
                    Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Link, Rect=[80, 380, 180, 410],
                    QuadPoints=[80, 410, 180, 410, 80, 380, 180, 380],
                    A=pikepdf.Dictionary(S=pikepdf.Name.URI, URI="https://example.com")))])
        return core._save(pdf, password)


def layout(pages=(1,), crop=None, resize=None, total=2):
    return core.parse_page_layout(json.dumps({"pages": list(pages), "crop": crop, "resize": resize}), total)


def margins(top=0, right=0, bottom=0, left=0):
    return dict(top=top, right=right, bottom=bottom, left=left)


@pytest.mark.parametrize(("rotation", "expected"), [
    (0, [40, 45, 410, 625]), (90, [25, 50, 405, 620]),
    (180, [30, 35, 400, 615]), (270, [35, 40, 415, 610]),
])
def test_crop_maps_displayed_edges_and_physical_units(rotation, expected):
    source = document(rotation=rotation, unit=2)
    result = core.organize(source, [(1, 0), (2, 0)], layout=layout(crop=margins(10 / PT, 20 / PT, 30 / PT, 40 / PT)))
    with pikepdf.open(BytesIO(source)) as before, pikepdf.open(BytesIO(result)) as after:
        assert list(after.pages[0].CropBox) == pytest.approx(expected)
        assert after.pages[0].MediaBox == before.pages[0].MediaBox
        assert after.pages[0].rotation == rotation
        assert after.pages[0].UserUnit == 2
        assert after.pages[0].Contents.read_bytes() == before.pages[0].Contents.read_bytes()
        assert after.pages[1].CropBox == before.pages[1].CropBox


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("unit", [1, 2])
def test_resize_selected_duplicate_to_exact_physical_size(rotation, unit):
    source = document(rotation=90, unit=unit)
    result = core.organize(source, [(1, 0), (1, rotation), (2, 0)], layout=layout(pages=[2], crop=margins(5, 10, 15, 20), resize=dict(width=297, height=210), total=3))
    with pikepdf.open(BytesIO(source)) as before, pikepdf.open(BytesIO(result)) as after:
        selected = after.pages[1]
        _, width, height = core._display_frame(selected)
        assert [width * unit, height * unit] == pytest.approx([297 * PT, 210 * PT], abs=1e-5)
        assert selected.rotation == (90 + rotation) % 360
        for untouched, original in ((after.pages[0], before.pages[0]), (after.pages[2], before.pages[1])):
            assert untouched.MediaBox == original.MediaBox
            assert untouched.CropBox == original.CropBox
            assert untouched.Contents.read_bytes() == original.Contents.read_bytes()
        form = selected.Resources.XObject.Content
        assert b"(Page 1)" in form.read_bytes()
        assert form.Resources.Font.F1.BaseFont == pikepdf.Name.Helvetica
        assert "/Matrix" not in form
        assert after.check_pdf_syntax() == []


def test_resized_content_is_centered_and_clipped_to_retained_crop():
    # Visible source is 400 x 600 pt. Crop 50 pt off left/right and
    # 100 pt off top/bottom => 300 x 400 pt, centered at 2x on 800 x 800.
    result = core.organize(document(), [(1, 0)], layout=layout(
        crop=margins(100 / PT, 50 / PT, 100 / PT, 50 / PT), resize=dict(width=800 / PT, height=800 / PT)))
    with pikepdf.open(BytesIO(result)) as pdf:
        page = pdf.pages[0]
        assert list(page.Resources.XObject.Content.BBox) == [70, 130, 370, 530]
        ops = pikepdf.parse_content_stream(page)
        matrix = next(values for values, operator in ops if str(operator) == "cm")
        assert list(matrix) == [2, 0, 0, 2, -40, -260]


def test_relative_rotation_happens_before_crop():
    a = core.organize(document(rotation=90), [(1, 90)], layout=layout(crop=margins(1, 2, 3, 4)))
    b = core.organize(document(rotation=180), [(1, 0)], layout=layout(crop=margins(1, 2, 3, 4)))
    with pikepdf.open(BytesIO(a)) as first, pikepdf.open(BytesIO(b)) as second:
        assert first.pages[0].CropBox == second.pages[0].CropBox


def test_crop_clips_to_media_box_and_handles_offset_origin():
    with pikepdf.open(BytesIO(document())) as pdf:
        page = pdf.pages[0]
        page.MediaBox = [-50, -100, 450, 600]
        page.CropBox = [-100, -200, 400, 800]
        source = core._save(pdf)
    result = core.organize(source, [(1, 0)], layout=layout(crop=margins(10 / PT, 20 / PT, 30 / PT, 40 / PT)))
    with pikepdf.open(BytesIO(result)) as pdf:
        assert list(pdf.pages[0].CropBox) == [-10, -70, 380, 590]


def test_links_scale_with_content_without_changing_unselected_duplicate():
    source = document(annotations=True)
    result = core.organize(source, [(1, 0), (1, 0)], layout=layout(pages=[2], resize=dict(width=800 / PT, height=1200 / PT)))
    with pikepdf.open(BytesIO(result)) as pdf:
        first, second = (page.Annots[0] for page in pdf.pages)
        assert list(first.Rect) == [80, 380, 180, 410]
        assert list(second.Rect) == [120, 700, 320, 760]
        assert list(second.QuadPoints) == [120, 760, 320, 760, 120, 700, 320, 700]
        assert second.A.URI == "https://example.com"


def test_form_widget_keeps_registered_identity_and_value_after_resize():
    with pikepdf.open(BytesIO(document())) as pdf:
        page = pdf.pages[0]
        widget = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget,
            FT=pikepdf.Name.Tx, T="Name", V="Ada", Rect=[80, 380, 180, 410], P=page.obj))
        widget.AP = pikepdf.Dictionary(N=pdf.make_stream(b"0.9 g 0 0 100 30 re f", Type=pikepdf.Name.XObject, Subtype=pikepdf.Name.Form, BBox=[0, 0, 100, 30]))
        page.Annots = pikepdf.Array([widget])
        pdf.Root.AcroForm = pikepdf.Dictionary(Fields=pikepdf.Array([widget]))
        source = core._save(pdf)
    result = core.organize(source, [(1, 0), (1, 0)], layout=layout(pages=[2], resize=dict(width=800 / PT, height=1200 / PT)))
    with pikepdf.open(BytesIO(result)) as pdf:
        fields = {field.obj.objgen: field for field in pdf.acroform.fields}
        for index, page in enumerate(pdf.pages):
            widget = page.Annots[0]
            assert widget.objgen in fields
            assert widget.V == "Ada"
            assert widget.AP.N.read_bytes()
            assert list(widget.Rect) == ([80, 380, 180, 410] if index == 0 else [120, 700, 320, 760])


def test_password_retained_for_crop_resize():
    result = core.organize(document(password="secret"), [(2, 0), (1, 90)], password="secret", layout=layout(crop=margins(5, 5, 5, 5), resize=dict(width=210, height=297)))
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(BytesIO(result))
    with pikepdf.open(BytesIO(result), password="secret") as pdf:
        assert len(pdf.pages) == 2


@pytest.mark.parametrize("bad", [
    "{", "[]", '{"pages":[]}', '{"pages":[1]}',
    json.dumps(dict(pages=[True], crop=margins())), json.dumps(dict(pages=[0], crop=margins())),
    json.dumps(dict(pages=[3], crop=margins())), json.dumps(dict(pages=[1.5], crop=margins())),
    json.dumps(dict(pages=[1], crop=margins(top=-1))), json.dumps(dict(pages=[1], crop=margins(top=float("nan")))),
    json.dumps(dict(pages=[1], crop=margins(top=10 ** 400))), json.dumps(dict(pages=[1], crop=margins(left="4"))),
    json.dumps(dict(pages=[1], resize=dict(width=0, height=297))), json.dumps(dict(pages=[1], resize=dict(width=210, height=float("inf")))),
])
def test_invalid_layout_returns_user_error(bad):
    with pytest.raises(core.PdfToolError):
        core.parse_page_layout(bad, 2)


def test_excessive_margins_report_the_selected_output_position():
    with pytest.raises(core.PdfToolError, match="output page 2"):
        core.organize(document(), [(2, 0), (1, 0)], layout=layout(pages=[2], crop=margins(left=200)))


def test_api_layout_uses_output_positions_and_download_headers():
    client = TestClient(app)
    response = client.post('/api/organize', files={'file': ('sample.pdf', document(), 'application/pdf')}, data={
        'pages': '2, 1:90, 1', 'layout': json.dumps(dict(pages=[2], crop=margins(5, 5, 5, 5), resize=dict(width=210, height=297)))})
    assert response.status_code == 200
    assert response.headers['content-type'] == 'application/pdf'
    assert response.headers['cache-control'] == 'no-store'
    assert 'sample_organized.pdf' in response.headers['content-disposition']
    with pikepdf.open(BytesIO(response.content)) as pdf:
        assert len(pdf.pages) == 3
        _, width, height = core._display_frame(pdf.pages[1])
        assert [width / PT, height / PT] == pytest.approx([210, 297])
        assert list(pdf.pages[2].CropBox) == [20, 30, 420, 630]
    bad = client.post('/api/organize', files={'file': ('sample.pdf', document(), 'application/pdf')}, data={'pages': '1', 'layout': json.dumps(dict(pages=[2], crop=margins()))})
    assert bad.status_code == 400
    assert 'output positions' in bad.json()['detail']
