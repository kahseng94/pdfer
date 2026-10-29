import json
import math
from io import BytesIO

import pikepdf
import pytest
from conftest import make_pdf
from fastapi.testclient import TestClient

from pdfer import core, fonts
from pdfer.api import app


NUMBERS = dict(position="bottom-center", margin=24, size=12, color="#374151", family="sans", start=1, mode="document", format="page-of-total")
WATERMARK = dict(position="center", margin=24, size=48, color="#6b7280", family="sans", text="DRAFT", opacity=0.2, rotation=-45)


def settings(pages="1-3", numbers=NUMBERS, watermark=None):
    return json.dumps(dict(pages=pages, numbers=numbers, watermark=watermark))


def text_runs(pdf, index):
    return [bytes(args[0]) for args, op in pikepdf.parse_content_stream(pdf.pages[index]) if str(op) == "Tj"]


def encoded(text):
    return fonts.fonts()["DejaVuSans.ttf"].encode(text)


def test_selection_is_deduplicated_sorted_and_numbers_use_document_pages():
    source = make_pdf([612] * 4)
    output = core.stamp(source, settings("3, 1, 3-4"))
    with pikepdf.open(BytesIO(source)) as original, pikepdf.open(BytesIO(output)) as pdf:
        assert len(pdf.pages) == 4
        assert text_runs(pdf, 0) == [encoded("Page 1 of 4")]
        assert text_runs(pdf, 2) == [encoded("Page 3 of 4")]
        assert text_runs(pdf, 3) == [encoded("Page 4 of 4")]
        assert pdf.pages[1].Contents.read_bytes() == original.pages[1].Contents.read_bytes()
        assert not text_runs(pdf, 1)


@pytest.mark.parametrize("format, expected", [
    ("number", ["5", "6"]), ("page", ["Page 5", "Page 6"]),
    ("of-total", ["5 of 6", "6 of 6"]), ("page-of-total", ["Page 5 of 6", "Page 6 of 6"]),
])
def test_selected_numbering_starts_at_the_first_selected_page(format, expected):
    output = core.stamp(make_pdf([612] * 4), settings("4, 2", numbers={**NUMBERS, "mode": "selected", "start": 5, "format": format}))
    with pikepdf.open(BytesIO(output)) as pdf:
        assert text_runs(pdf, 1) == [encoded(expected[0])]
        assert text_runs(pdf, 3) == [encoded(expected[1])]
        assert not text_runs(pdf, 0)


def test_watermark_opacity_does_not_affect_page_numbers_or_original_content():
    with pikepdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(612, 792))
        page.Contents = pdf.make_stream(b"0 0 1 rg 10 10 100 100 re f")
        stream = BytesIO()
        pdf.save(stream)
    output = core.stamp(stream.getvalue(), settings("1", watermark=WATERMARK))
    with pikepdf.open(BytesIO(output)) as pdf:
        assert text_runs(pdf, 0) == [encoded("DRAFT"), encoded("Page 1 of 1")]
        states = list(pdf.pages[0].Resources.ExtGState.values())
        assert sorted(float(state.ca) for state in states) == [0.2, 1]
        assert all(float(state.CA) == float(state.ca) for state in states)
        content = pdf.pages[0].Contents
        assert b"0 0 1 rg 10 10 100 100 re f" in b"".join(part.read_bytes() for part in content)
        assert float(pdf.pdf_version) >= 1.4


def test_watermark_only_embeds_unicode_as_searchable_text():
    text = "Πρόχειρο — Черновик"
    output = core.stamp(make_pdf([612]), settings("1", numbers=None, watermark={**WATERMARK, "text": text}))
    with pikepdf.open(BytesIO(output)) as pdf:
        assert text_runs(pdf, 0) == [encoded(text)]
        assert all("/ToUnicode" in font for font in pdf.pages[0].Resources.Font.values())


@pytest.mark.parametrize("position", core.STAMP_POSITIONS)
def test_rotated_text_fits_inside_margins_at_every_position(position):
    style = core.parse_stamps(settings("1", numbers=None, watermark={**WATERMARK, "position": position, "text": "A long watermark that must shrink to fit"}), 1).watermark
    stamp = core._place_stamp(1, 300, 200, 1, style, style.text, rotation=45)
    assert stamp.size < style.size
    angle = math.radians(stamp.rotation)
    corners = [(stamp.x + x * math.cos(angle) - y * math.sin(angle), stamp.y + x * math.sin(angle) + y * math.cos(angle))
               for x in (-stamp.width / 2, stamp.width / 2) for y in (-stamp.height / 2, stamp.height / 2)]
    left, right = min(x for x, _ in corners), max(x for x, _ in corners)
    top, bottom = min(y for _, y in corners), max(y for _, y in corners)
    assert left >= style.margin - 1e-6
    assert right <= 300 - style.margin + 1e-6
    assert top >= style.margin - 1e-6
    assert bottom <= 200 - style.margin + 1e-6
    if position.endswith("left"):
        assert left == pytest.approx(style.margin)
    if position.endswith("right"):
        assert right == pytest.approx(300 - style.margin)
    if position.startswith("top"):
        assert top == pytest.approx(style.margin)
    if position.startswith("bottom"):
        assert bottom == pytest.approx(200 - style.margin)
    if position == "center":
        assert (stamp.x, stamp.y) == (150, 100)


@pytest.mark.parametrize("rotation", [-180, -90, -45, 0, 45, 90, 180])
def test_watermark_rotation_is_clockwise_in_display_coordinates(rotation):
    output = core.stamp(make_pdf([612]), settings("1", numbers=None, watermark={**WATERMARK, "rotation": rotation}))
    with pikepdf.open(BytesIO(output)) as pdf:
        matrices = [list(map(float, args)) for args, op in pikepdf.parse_content_stream(pdf.pages[0]) if str(op) == "cm"]
        cos, sin = math.cos(math.radians(-rotation)), math.sin(math.radians(-rotation))
        assert matrices[-1][:4] == pytest.approx([cos, sin, -sin, cos], abs=0.001)


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_crop_rotation_and_page_unit_are_preserved_and_respected(rotation):
    with pikepdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(400, 600))
        page.CropBox = [30, 40, 330, 440]
        page.Rotate = rotation
        page.UserUnit = 2
        stream = BytesIO()
        pdf.save(stream)
    output = core.stamp(stream.getvalue(), settings("1", numbers={**NUMBERS, "position": "top-left"}))
    with pikepdf.open(BytesIO(output)) as pdf:
        page = pdf.pages[0]
        assert list(page.CropBox) == [30, 40, 330, 440]
        assert page.Rotate == rotation
        assert page.UserUnit == 2
        instructions = pikepdf.parse_content_stream(page)
        sizes = [float(args[1]) for args, op in instructions if str(op) == "Tf"]
        assert sizes == [6]  # six user-space units are twelve physical points
        matrices = [list(map(float, args)) for args, op in instructions if str(op) == "cm"]
        expected = {0: [1, 0, 0, 1, 30, 40], 90: [0, 1, -1, 0, 330, 40], 180: [-1, 0, 0, -1, 330, 440], 270: [0, -1, 1, 0, 30, 440]}[rotation]
        assert matrices[0] == expected


@pytest.mark.parametrize("change", [
    {"pages": ""}, {"pages": "1, 9"}, {"pages": "3-1"}, {"numbers": None},
    {"numbers": {**NUMBERS, "start": 1.5}}, {"numbers": {**NUMBERS, "start": True}},
    {"numbers": {**NUMBERS, "position": "center"}}, {"numbers": {**NUMBERS, "size": 0}},
    {"watermark": {**WATERMARK, "text": ""}}, {"watermark": {**WATERMARK, "text": "two\nlines"}},
    {"watermark": {**WATERMARK, "text": "x" * 201}}, {"watermark": {**WATERMARK, "opacity": 0}},
    {"watermark": {**WATERMARK, "opacity": float("nan")}}, {"watermark": {**WATERMARK, "rotation": 181}},
    {"numbers": {**NUMBERS, "margin": -1}}, {"numbers": {**NUMBERS, "color": "red"}},
])
def test_invalid_settings_are_rejected(change):
    with pytest.raises(core.PdfToolError):
        core.parse_stamps(json.dumps({"pages": "1-3", "numbers": NUMBERS, "watermark": None, **change}), 3)


def test_tiny_pages_report_unusable_margins():
    with pytest.raises(core.PdfToolError, match="Reduce the margin"):
        core.stamp(make_pdf([20]), settings("1"))


def test_stamp_api_preserves_protection_and_returns_the_complete_document():
    client = TestClient(app)
    source = make_pdf([612] * 3, password="secret")
    response = client.post("/api/stamp", files={"file": ("private.pdf", source, "application/pdf")}, data={"password": "secret", "settings": settings("2", watermark=WATERMARK)})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert "private_stamped.pdf" in response.headers["content-disposition"]
    assert response.headers["cache-control"] == "no-store"
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(BytesIO(response.content))
    with pikepdf.open(BytesIO(response.content), password="secret") as pdf:
        assert len(pdf.pages) == 3
        assert not text_runs(pdf, 0)
        assert text_runs(pdf, 1) == [encoded("DRAFT"), encoded("Page 2 of 3")]


@pytest.mark.parametrize("payload", ["{}", "[]", "not json", settings("9")])
def test_stamp_api_rejects_bad_requests(payload):
    response = TestClient(app).post("/api/stamp", files={"file": ("input.pdf", make_pdf([612]), "application/pdf")}, data={"settings": payload})
    assert response.status_code == 400


def test_stamp_api_rejects_wrong_password():
    response = TestClient(app).post("/api/stamp", files={"file": ("private.pdf", make_pdf([612], password="secret"), "application/pdf")}, data={"settings": settings("1"), "password": "wrong"})
    assert response.status_code == 400
    assert "incorrect" in response.json()["detail"]
