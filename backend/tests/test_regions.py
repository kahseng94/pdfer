import json
from dataclasses import replace
from io import BytesIO

import pikepdf
import pypdfium2 as pdfium
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageChops, ImageDraw, ImageStat

from pdfer import core
from pdfer.api import app
from conftest import make_image_pdf


def document(rotation=0, unit=1, password=""):
    with pikepdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(400, 500))
        page.MediaBox = [-20, -30, 380, 470]
        page.CropBox = [20, 30, 320, 430]
        page.Rotate = rotation
        page.UserUnit = unit
        font = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
        nested = pdf.make_stream(b"0.8 0.2 0.1 rg 0 0 m 50 0 l 25 50 l h f", Type=pikepdf.Name.XObject,
                                 Subtype=pikepdf.Name.Form, BBox=[0, 0, 50, 50], Resources=pikepdf.Dictionary())
        page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font), XObject=pikepdf.Dictionary(Triangle=nested))
        page.Contents = pdf.make_stream(
            b"0.1 0.7 0.3 rg 50 290 100 80 re f "
            b"0.1 0.3 0.9 rg 180 70 100 150 re f "
            b"q 1 0 0 1 80 150 cm /Triangle Do Q "
            b"0 g BT /F1 18 Tf 55 315 Td (Move this text) Tj ET "
            b"BT /F1 16 Tf 45 390 Td (Original PDF) Tj ET"
        )
        other = pdf.add_blank_page(page_size=(240, 360))
        other.Contents = pdf.make_stream(b"0.4 g 20 20 200 300 re f")
        pdf.docinfo.Title = "Region fixture"
        return core._save(pdf, password)


def render(data, password="", number=0, scale=2):
    with pdfium.PdfDocument(data, password=password) as pdf:
        page = pdf[number]
        try:
            bitmap = page.render(scale=scale)
            try:
                return bitmap.to_pil().convert("RGB")
            finally:
                bitmap.close()
        finally:
            page.close()


def region(rotation=0, unit=1):
    width, height = ((400, 300) if rotation in (90, 270) else (300, 400))
    return core.RegionEdit(page=1, source=(width * .1 * unit, height * .15 * unit, width * .35 * unit, height * .25 * unit),
                           x=width * .5 * unit, y=height * .6 * unit, width=width * .35 * unit, height=height * .25 * unit)


def pixel_box(box, image, width, height):
    x, y, w, h = box
    return tuple(round(v) for v in (x / width * image.width, y / height * image.height,
                                   (x + w) / width * image.width, (y + h) / height * image.height))


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("unit", [1, 2])
def test_move_matches_visible_crop_with_rotation_offset_and_userunit(rotation, unit):
    source = document(rotation, unit)
    edit = region(rotation, unit)
    output = core.edit(source, [edit])
    before, after = render(source), render(output)
    width, height = ((400, 300) if rotation in (90, 270) else (300, 400))
    box = pixel_box(edit.source, before, width * unit, height * unit)
    destination = pixel_box((edit.x, edit.y, edit.width, edit.height), before, width * unit, height * unit)
    expected = before.copy()
    ImageDraw.Draw(expected).rectangle((box[0], box[1], box[2] - 1, box[3] - 1), fill="white")
    expected.paste(before.crop(box), destination[:2])
    assert max(ImageStat.Stat(ImageChops.difference(after, expected)).mean) < .05
    with pikepdf.open(BytesIO(source)) as original, pikepdf.open(BytesIO(output)) as pdf:
        assert pdf.check_pdf_syntax() == []
        assert pdf.pages[1].Contents.read_bytes() == original.pages[1].Contents.read_bytes()
        assert pdf.docinfo.Title == "Region fixture"
        assert pdf.pages[0].MediaBox == original.pages[0].MediaBox
        assert pdf.pages[0].CropBox == original.pages[0].CropBox
        forms = list(pdf.pages[0].Resources.XObject.values())
        assert all(form.Subtype == pikepdf.Name.Form for form in forms)  # no rasterization
        snapshot = next(form for form in forms if b"Move this text" in form.read_bytes())
        assert snapshot.Resources.Font.F1.BaseFont == pikepdf.Name.Helvetica
        assert list(snapshot.Resources.XObject.keys()) == ["/Triangle"]  # no recursive resource


def test_resize_preserves_text_and_scales_destination_without_leaking_nearby_content():
    edit = core.RegionEdit(page=1, source=(30, 60, 70, 60), x=160, y=200, width=140, height=120)
    output = core.edit(document(), [edit])
    image = render(output)
    # Solid green interior scales 2x; the vacated source is white.
    assert image.getpixel((400, 440)) == (26, 179, 77)
    assert image.getpixel((100, 160)) == (255, 255, 255)
    with pdfium.PdfDocument(output) as pdf:
        page = pdf[0]
        text = page.get_textpage()
        try:
            assert "Move this text" in text.get_text_range()
        finally:
            text.close()
            page.close()


def test_regions_sample_original_before_masks_and_respect_overlay_order():
    # Swap two areas. The second must not sample the first's destination or mask.
    a = core.RegionEdit(page=1, source=(30, 60, 100, 80), x=160, y=220, width=100, height=80)
    b = core.RegionEdit(page=1, source=(160, 220, 100, 80), x=30, y=60, width=100, height=80)
    source = document()
    before = render(source)
    expected = before.copy()
    first = pixel_box(a.source, before, 300, 400)
    second = pixel_box(b.source, before, 300, 400)
    expected.paste(before.crop(first), second[:2])
    expected.paste(before.crop(second), first[:2])
    output = core.edit(source, [a, b])
    assert max(ImageStat.Stat(ImageChops.difference(render(output), expected)).mean) < .05
    overlay = core.ShapeEdit(page=1, shape="rect", x=50, y=80, width=10, height=10, stroke=None, stroke_width=0, fill=(1, 0, 0))
    painted = render(core.edit(source, [a, b, overlay]))
    assert painted.getpixel((110, 170)) == (255, 0, 0)


def test_original_defaults_do_not_inherit_white_background_or_previous_edit_style():
    with pikepdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(300, 400))
        page.Contents = pdf.make_stream(b"20 300 40 40 re f 20 350 m 60 350 l S")
        source = core._save(pdf)
    region = core.RegionEdit(page=1, source=(10, 40, 60, 70), x=110, y=200, width=60, height=70)
    styled = core.ShapeEdit(page=1, shape="rect", x=0, y=0, width=5, height=5, stroke=(1, 0, 0), stroke_width=10, fill=(0, 1, 0))
    before, after = render(source), render(core.edit(source, [styled, region]))
    original = before.crop((20, 80, 140, 220))
    moved = after.crop((220, 400, 340, 540))
    assert ImageChops.difference(original, moved).getbbox() is None


@pytest.mark.parametrize("nested", [False, True])
def test_scanned_image_regions_keep_original_image_data(nested):
    source = make_image_pdf(side=40, nested=nested)
    move = core.RegionEdit(page=1, source=(30, 60, 100, 100), x=200, y=300, width=100, height=100)
    before, after = render(source), render(core.edit(source, [move]))
    assert max(ImageStat.Stat(ImageChops.difference(before.crop((60, 120, 260, 320)), after.crop((400, 600, 600, 800)))).mean) < .1


def payload():
    return dict(type="region", page=1, source=dict(x=30, y=60, width=70, height=60), x=160, y=200, width=100, height=80)


@pytest.mark.parametrize("patch", [
    {"source": None}, {"source": {"x": 1}}, {"source": dict(x=-1, y=0, width=10, height=10)},
    {"x": -1}, {"width": 0}, {"height": True}, {"y": float("inf")}, {"width": float("nan")}, {"page": 3},
    {"sourcePage": 0}, {"sourcePage": 3}, {"sourcePage": True}, {"sourcePage": 1.5}, {"sourcePage": "1"},
    {"deleted": "true"}, {"deleted": 1}, {"deleted": None},
    {"copy": "true"}, {"copy": 1}, {"copy": None}, {"copy": True, "deleted": True},
    {"rotation": 45}, {"rotation": -90}, {"rotation": 360}, {"rotation": 90.5}, {"rotation": False}, {"rotation": "90"}, {"rotation": None},
])
def test_invalid_regions_are_400(patch):
    with TestClient(app) as client:
        response = client.post("/api/edit", files={"file": ("source.pdf", document(), "application/pdf")},
                               data={"edits": json.dumps([payload() | patch])})
    assert response.status_code == 400
    assert response.json()["detail"]


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("unit", [1, 2])
def test_delete_region_covers_only_its_source_and_leaves_former_destination_untouched(rotation, unit):
    source = document(rotation, unit)
    deletion = replace(region(rotation, unit), source_page=1, page=2, deleted=True)
    output = core.edit(source, [deletion])
    before = render(source)
    width, height = ((400, 300) if rotation in (90, 270) else (300, 400))
    box = pixel_box(deletion.source, before, width * unit, height * unit)
    expected = before.copy()
    ImageDraw.Draw(expected).rectangle((box[0], box[1], box[2] - 1, box[3] - 1), fill="white")
    assert max(ImageStat.Stat(ImageChops.difference(render(output), expected)).mean) < .05
    assert ImageChops.difference(render(source, number=1), render(output, number=1)).getbbox() is None
    with pikepdf.open(BytesIO(source)) as original, pikepdf.open(BytesIO(output)) as pdf:
        assert pdf.pages[1].Contents.read_bytes() == original.pages[1].Contents.read_bytes()
        assert list(pdf.pages[0].Resources.XObject.keys()) == ["/Triangle"]  # no cutout form is needed
        assert pdf.check_pdf_syntax() == []


def test_delete_on_the_source_page_is_not_undone_by_painting_the_cutout():
    deletion = replace(region(), deleted=True, x=30, y=60)
    output = core.edit(document(), [deletion])
    assert render(output).getpixel((120, 180)) == (255, 255, 255)


def test_deleted_regions_can_export_with_other_moved_regions_and_overlays():
    source = document()
    removed = core.RegionEdit(page=1, source=(30, 60, 100, 80), x=30, y=60, width=100, height=80, deleted=True)
    moved = core.RegionEdit(source_page=1, page=2, source=(160, 220, 50, 80), x=30, y=60, width=50, height=80)
    overlay = core.ShapeEdit(page=1, shape="rect", x=50, y=80, width=10, height=10, stroke=None, stroke_width=0, fill=(1, 0, 0))
    output = core.edit(source, [removed, moved, overlay])
    assert render(output).getpixel((110, 170)) == (255, 0, 0)
    before, after = render(source), render(output, number=1)
    assert ImageChops.difference(before.crop((320, 440, 420, 600)), after.crop((60, 120, 160, 280))).getbbox() is None


def test_delete_api_retains_password_and_ignores_unused_destination_geometry():
    with TestClient(app) as client:
        response = client.post("/api/edit", files={"file": ("source.pdf", document(password="secret"), "application/pdf")},
                               data={"password": "secret", "edits": json.dumps([payload() | {"sourcePage": 1, "page": 2, "x": 9999, "deleted": True}])})
    assert response.status_code == 200
    with pikepdf.open(BytesIO(response.content), password="secret") as pdf:
        assert pdf.is_encrypted
        assert len(pdf.pages) == 2
    assert render(response.content, "secret").getpixel((100, 160)) == (255, 255, 255)


def test_api_retains_password_and_accepts_regions_without_uploaded_images():
    with TestClient(app) as client:
        response = client.post("/api/edit", files={"file": ("source.pdf", document(password="secret"), "application/pdf")},
                               data={"edits": json.dumps([payload()]), "password": "secret"})
    assert response.status_code == 200
    assert "source_edited.pdf" in response.headers["content-disposition"]
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(BytesIO(response.content))
    with pikepdf.open(BytesIO(response.content), password="secret") as pdf:
        assert pdf.is_encrypted
        assert len(pdf.pages) == 2


@pytest.mark.parametrize("source_rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("destination_rotation", [0, 90, 180, 270])
@pytest.mark.parametrize(("source_unit", "destination_unit"), [(1, 1), (2, 1), (1, 2)])
@pytest.mark.parametrize("copy", [False, True])
@pytest.mark.parametrize("region_rotation", [0, 90, 180, 270])
def test_cross_page_region_preserves_visible_orientation_and_physical_size(source_rotation, destination_rotation, source_unit, destination_unit, copy, region_rotation):
    with pikepdf.open(BytesIO(document(source_rotation, source_unit))) as pdf:
        target = pdf.pages[1]
        target.CropBox = [10, 20, 210, 320]
        target.Rotate = destination_rotation
        target.UserUnit = destination_unit
        source = core._save(pdf)
        _, sw, sh = core._display_frame(pdf.pages[0])
        _, dw, dh = core._display_frame(target)
    turned = region_rotation in (90, 270)
    cut = core.RegionEdit(source_page=1, page=2, copy=copy, rotation=region_rotation, source=(40 * source_unit, 60 * source_unit, 80 * source_unit, 60 * source_unit),
                          x=20, y=30, width=(60 if turned else 80) * source_unit, height=(80 if turned else 60) * source_unit)
    output = core.edit(source, [cut])
    before_source = render(source, scale=2 * source_unit)
    before_destination = render(source, number=1, scale=2 * destination_unit)
    source_box = pixel_box(cut.source, before_source, sw * source_unit, sh * source_unit)
    dest_box = pixel_box((cut.x, cut.y, cut.width, cut.height), before_destination, dw * destination_unit, dh * destination_unit)
    expected_source = before_source.copy()
    if not copy:
        ImageDraw.Draw(expected_source).rectangle((source_box[0], source_box[1], source_box[2] - 1, source_box[3] - 1), fill="white")
    expected_destination = before_destination.copy()
    cutout = before_source.crop(source_box)
    if region_rotation:
        cutout = cutout.transpose({90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_90}[region_rotation])
    expected_destination.paste(cutout, dest_box[:2])
    assert max(ImageStat.Stat(ImageChops.difference(render(output, scale=2 * source_unit), expected_source)).mean) < .05
    difference = ImageChops.difference(render(output, number=1, scale=2 * destination_unit), expected_destination)
    # PDFium hints vector glyphs again after rotation. Those edge pixels differ
    # slightly from rotating an already-rendered bitmap; geometry stays exact.
    assert max(ImageStat.Stat(difference).mean) < (.15 if region_rotation else .05)
    ImageDraw.Draw(difference).rectangle((dest_box[0], dest_box[1], dest_box[2] - 1, dest_box[3] - 1), fill=(0, 0, 0))
    assert difference.getbbox() is None
    with pikepdf.open(BytesIO(output)) as pdf:
        assert pdf.check_pdf_syntax() == []
        assert pdf.pages[0].rotation == source_rotation
        assert pdf.pages[1].rotation == destination_rotation


def test_copy_leaves_original_content_and_resources_untouched_and_preserves_password():
    source = document(password="secret")
    copy = core.RegionEdit(source_page=1, page=2, copy=True, source=(20, 55, 140, 90), x=20, y=50, width=140, height=90)
    with TestClient(app) as client:
        response = client.post("/api/edit", files={"file": ("source.pdf", source, "application/pdf")},
                               data={"password": "secret", "edits": json.dumps([payload() | {"page": 2, "sourcePage": 1, "copy": True, "x": 20}])})
    assert response.status_code == 200
    output = core.edit(source, [copy], password="secret")
    with pikepdf.open(BytesIO(source), password="secret") as original, pikepdf.open(BytesIO(output), password="secret") as pdf:
        assert pdf.is_encrypted
        assert pdf.pages[0].Contents.read_bytes() == original.pages[0].Contents.read_bytes()
        assert list(pdf.pages[0].Resources.XObject.keys()) == ["/Triangle"]
        form = next(iter(pdf.pages[1].Resources.XObject.values()))
        assert form.Subtype == pikepdf.Name.Form
        assert b"Move this text" in form.read_bytes()
    assert ImageChops.difference(render(source, "secret"), render(output, "secret")).getbbox() is None


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("unit", [1, 2])
def test_same_page_copy_keeps_original_visible_and_renders_at_its_new_position(rotation, unit):
    source = document(rotation, unit)
    copied = replace(region(rotation, unit), source_page=1, copy=True)
    # Match the editor's original selection plus an independently placed copy.
    selected = replace(copied, copy=False, x=copied.source[0], y=copied.source[1])
    output = core.edit(source, [selected, copied])
    before = render(source)
    width, height = ((400, 300) if rotation in (90, 270) else (300, 400))
    source_box = pixel_box(copied.source, before, width * unit, height * unit)
    dest_box = pixel_box((copied.x, copied.y, copied.width, copied.height), before, width * unit, height * unit)
    expected = before.copy()
    expected.paste(before.crop(source_box), dest_box[:2])
    assert max(ImageStat.Stat(ImageChops.difference(render(output), expected)).mean) < .05
    with pikepdf.open(BytesIO(source)) as original, pikepdf.open(BytesIO(output)) as pdf:
        assert pdf.check_pdf_syntax() == []
        assert pdf.pages[1].Contents.read_bytes() == original.pages[1].Contents.read_bytes()


@pytest.mark.parametrize("deleted", [False, True])
def test_copies_share_sources_with_moves_or_deletions_without_covering_them_again(deleted):
    source = document()
    original = replace(region(), deleted=deleted)
    first = replace(original, copy=True, deleted=False, source_page=1, page=2, x=10, y=20)
    second = replace(first, x=120, y=200)
    output = core.edit(source, [first, original, second])
    assert ImageChops.difference(render(core.edit(source, [original])), render(output)).getbbox() is None
    before = render(source)
    crop = before.crop(pixel_box(first.source, before, 300, 400))
    expected = render(source, number=1)
    expected.paste(crop, (20, 40))
    expected.paste(crop, (240, 400))
    assert max(ImageStat.Stat(ImageChops.difference(expected, render(output, number=1))).mean) < .05
    with pikepdf.open(BytesIO(output)) as pdf:
        assert len(pdf.pages[1].Resources.XObject) == 1  # reuse one frozen source form
    with pytest.raises(core.PdfToolError, match="overlap"):
        core.edit(source, [first, original, second, replace(original, x=0)])


def test_swapping_regions_between_pages_freezes_every_source_before_painting():
    source = document()
    a = core.RegionEdit(source_page=1, page=2, source=(30, 60, 100, 80), x=30, y=60, width=100, height=80)
    b = replace(a, source_page=2, page=1)
    before = [render(source, number=i) for i in range(2)]
    box = (60, 120, 260, 280)
    expected = [image.copy() for image in before]
    expected[0].paste(before[1].crop(box), box[:2])
    expected[1].paste(before[0].crop(box), box[:2])
    output = core.edit(source, [a, b])
    for i in range(2):
        assert max(ImageStat.Stat(ImageChops.difference(render(output, number=i), expected[i])).mean) < .05


def test_cross_page_source_does_not_include_new_overlays_and_keeps_text_as_pdf_content():
    region = core.RegionEdit(source_page=1, page=2, source=(20, 55, 140, 90), x=20, y=50, width=140, height=90)
    overlay = core.ShapeEdit(page=1, shape="rect", x=20, y=55, width=140, height=90, stroke=None, stroke_width=0, fill=(1, 0, 0))
    source = document(password="secret")
    output = core.edit(source, [overlay, region], password="secret")
    image = render(output, "secret", number=1)
    assert image.getpixel((80, 120)) != (255, 0, 0)
    with pikepdf.open(BytesIO(output), password="secret") as pdf:
        assert pdf.is_encrypted
        form = next(iter(pdf.pages[1].Resources.XObject.values()))
        assert form.Subtype == pikepdf.Name.Form
        assert b"Move this text" in form.read_bytes()
        assert b"1 0 0 rg" not in form.read_bytes()


def test_cross_page_api_and_source_validation():
    with TestClient(app) as client:
        for patch, status in [({"sourcePage": 1, "page": 2, "x": 20}, 200),
                              ({"sourcePage": 1, "page": 2, "x": 200}, 400)]:
            response = client.post("/api/edit", files={"file": ("source.pdf", document(), "application/pdf")},
                                   data={"edits": json.dumps([payload() | patch])})
            assert response.status_code == status
    # Overlap is checked on the source even if destinations differ.
    with pytest.raises(core.PdfToolError, match="overlap"):
        core.edit(document(), [replace(region(), source_page=1), replace(region(), source_page=1, page=2, x=0)])
    with pytest.raises(core.PdfToolError, match="Source page"):
        core.edit(document(), [replace(region(), source_page=3)])


@pytest.mark.parametrize("on_source", [True, False])
def test_cross_page_annotations_checked_on_both_pages(on_source):
    with pikepdf.open(BytesIO(document())) as pdf:
        page = pdf.pages[0 if on_source else 1]
        page.Annots = [pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Link,
                      Rect=[50, 300, 120, 350] if on_source else [20, 220, 160, 310]))]
        source = core._save(pdf)
    with pytest.raises(core.PdfToolError, match=f"page {1 if on_source else 2} touches"):
        core.edit(source, [core.RegionEdit(source_page=1, page=2, source=(20, 55, 140, 90), x=20, y=50, width=140, height=90)])


def test_rejects_outside_page_overlapping_sources_and_excessive_regions():
    source = document()
    original = region()
    for edit in (replace(original, x=290), replace(original, source=(299, 0, 5, 5)), replace(original, height=float("nan"))):
        with pytest.raises(core.PdfToolError, match="must fit inside"):
            core.edit(source, [edit])
    with pytest.raises(core.PdfToolError, match="overlap"):
        core.edit(source, [original, replace(original, x=0)])
    with pytest.raises(core.PdfToolError, match="200 regions"):
        core.edit(source, [original] * 201)


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("at_destination", [False, True])
def test_rejects_regions_touching_interactive_objects(rotation, at_destination):
    edit = region(rotation, 2)
    with pikepdf.open(BytesIO(document(rotation, 2))) as pdf:
        page = pdf.pages[0]
        frame, _, height = core._display_frame(page)
        x, y, w, h = (edit.x, edit.y, edit.width, edit.height) if at_destination else edit.source
        native = pikepdf.Matrix(*frame).transform(pikepdf.Rectangle(x / 2, height - (y + h) / 2, (x + w) / 2, height - y / 2))
        page.Annots = [pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Link,
                      Rect=[native.llx, native.lly, native.urx, native.ury], A=pikepdf.Dictionary(S=pikepdf.Name.URI, URI="https://example.com")))]
        source = core._save(pdf)
    with pytest.raises(core.PdfToolError, match="touches a link, annotation or form field"):
        core.edit(source, [edit])


# --- Copying from another PDF -------------------------------------------------

def destination(rotation=0, unit=1, password=""):
    """A separate PDF to paste into: a marked first page and a cropped, rotated second page."""
    with pikepdf.new() as pdf:
        first = pdf.add_blank_page(page_size=(300, 400))
        first.Contents = pdf.make_stream(b"0.9 0.8 0.1 rg 0 340 60 60 re f")
        target = pdf.add_blank_page(page_size=(240, 360))
        target.CropBox = [10, 20, 210, 320]
        target.Rotate = rotation
        target.UserUnit = unit
        pdf.docinfo.Title = "Destination fixture"
        return core._save(pdf, password)


@pytest.mark.parametrize("source_rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("destination_rotation", [0, 90, 180, 270])
@pytest.mark.parametrize(("source_unit", "destination_unit"), [(1, 1), (2, 1), (1, 2)])
@pytest.mark.parametrize("region_rotation", [0, 90, 180, 270])
def test_copy_from_another_pdf_matches_its_visible_crop(source_rotation, destination_rotation, source_unit, destination_unit, region_rotation):
    other = document(source_rotation, source_unit)
    target = destination(destination_rotation, destination_unit)
    with pikepdf.open(BytesIO(other)) as pdf:
        _, sw, sh = core._display_frame(pdf.pages[0])
    with pikepdf.open(BytesIO(target)) as pdf:
        _, dw, dh = core._display_frame(pdf.pages[1])
    turned = region_rotation in (90, 270)
    cut = core.RegionEdit(source_document=0, source_page=1, page=2, rotation=region_rotation, source=(40 * source_unit, 60 * source_unit, 80 * source_unit, 60 * source_unit),
                          x=20, y=30, width=(60 if turned else 80) * source_unit, height=(80 if turned else 60) * source_unit)
    output = core.edit(target, [cut], sources=[("other.pdf", other, "")])
    before_source = render(other, scale=2 * source_unit)
    before_destination = render(target, number=1, scale=2 * destination_unit)
    source_box = pixel_box(cut.source, before_source, sw * source_unit, sh * source_unit)
    dest_box = pixel_box((cut.x, cut.y, cut.width, cut.height), before_destination, dw * destination_unit, dh * destination_unit)
    expected = before_destination.copy()
    cutout = before_source.crop(source_box)
    if region_rotation:
        cutout = cutout.transpose({90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_90}[region_rotation])
    expected.paste(cutout, dest_box[:2])
    difference = ImageChops.difference(render(output, number=1, scale=2 * destination_unit), expected)
    assert max(ImageStat.Stat(difference).mean) < (.15 if region_rotation else .05)
    ImageDraw.Draw(difference).rectangle((dest_box[0], dest_box[1], dest_box[2] - 1, dest_box[3] - 1), fill=(0, 0, 0))
    assert difference.getbbox() is None
    # The first page and the other PDF are exactly as they were.
    assert ImageChops.difference(render(target), render(output)).getbbox() is None
    with pikepdf.open(BytesIO(target)) as original, pikepdf.open(BytesIO(output)) as pdf:
        assert pdf.check_pdf_syntax() == []
        assert len(pdf.pages) == 2
        assert pdf.docinfo.Title == "Destination fixture"
        assert pdf.pages[0].Contents.read_bytes() == original.pages[0].Contents.read_bytes()
        assert pdf.pages[1].rotation == destination_rotation
        form = next(iter(pdf.pages[1].Resources.XObject.values()))
        assert form.Subtype == pikepdf.Name.Form  # the other page's objects, not a picture of them
        assert b"Move this text" in form.read_bytes()
        assert form.Resources.Font.F1.BaseFont == pikepdf.Name.Helvetica
        assert list(form.Resources.XObject.keys()) == ["/Triangle"]


def test_copies_from_another_pdf_share_one_frozen_page_and_keep_its_text_and_password():
    other = document(password="secret")
    target = destination(password="target")
    first = core.RegionEdit(source_document=0, source_page=1, page=1, source=(20, 55, 140, 90), x=20, y=50, width=140, height=90)
    second = replace(first, page=2, x=10, y=10, width=70, height=45)
    local = core.RegionEdit(source_page=1, page=2, copy=True, source=(0, 0, 60, 60), x=100, y=200, width=60, height=60)
    output = core.edit(target, [first, second, local], password="target", sources=[("other.pdf", other, "secret")])
    with pikepdf.open(BytesIO(output), password="target") as pdf:
        assert pdf.is_encrypted
        assert pdf.check_pdf_syntax() == []
        forms = [list(page.Resources.XObject.values()) for page in pdf.pages]
        assert len(forms[0]) == 1 and len(forms[1]) == 2
        assert forms[0][0].objgen == next(form for form in forms[1] if b"Move this text" in form.read_bytes()).objgen
    with pdfium.PdfDocument(output, password="target") as pdf:
        for number in range(2):
            page = pdf[number]
            text = page.get_textpage()
            try:
                assert "Move this text" in text.get_text_range()
            finally:
                text.close()
                page.close()
    image = render(output, "target", number=1)
    assert image.getpixel((260, 460)) == (230, 204, 26)  # the local copy, drawn from this PDF's own page


def test_copies_from_another_pdf_never_vacate_and_keep_the_output_version_high_enough():
    other = document()
    with pikepdf.open(BytesIO(other)) as pdf:
        pdf.save(buffer := BytesIO(), min_version="1.7")
        other = buffer.getvalue()
    target = destination()
    not_a_copy = core.RegionEdit(source_document=0, source_page=1, page=1, copy=False, source=(20, 55, 140, 90), x=20, y=50, width=140, height=90)
    output = core.edit(target, [not_a_copy], sources=[("other.pdf", other, "")])
    assert render(output).getpixel((60, 60)) != (255, 255, 255)  # nothing is painted white; the other PDF had nothing to vacate
    with pikepdf.open(BytesIO(output)) as pdf:
        assert pdf.pdf_version >= "1.7"


def test_copy_from_another_pdf_validation():
    other = document()
    target = destination()
    valid = core.RegionEdit(source_document=0, source_page=1, page=1, source=(20, 55, 140, 90), x=20, y=50, width=140, height=90)
    for edit, message in [
        (replace(valid, source_document=1), "source PDF that wasn't provided"),
        (replace(valid, source_page=3), "outside pages 1-2 of other.pdf"),
        (replace(valid, deleted=True), "cannot be deleted"),
        (replace(valid, source=(200, 55, 140, 90)), "page 1 of other.pdf"),
    ]:
        with pytest.raises(core.PdfToolError, match=message):
            core.edit(target, [edit], sources=[("other.pdf", other, "")])
    with pytest.raises(core.PdfToolError, match="password for other.pdf is incorrect"):
        core.edit(target, [valid], sources=[("other.pdf", document(password="secret"), "wrong")])
    with pytest.raises(core.PdfToolError, match="other.pdf is password-protected"):
        core.edit(target, [valid], sources=[("other.pdf", document(password="secret"), "")])
    with pytest.raises(core.PdfToolError, match="source PDF that wasn't uploaded"):
        core.parse_edits(json.dumps([payload() | {"sourceDocument": 0}]), 2, 0, 0)
    for patch in [{"sourceDocument": True}, {"sourceDocument": "0"}, {"sourceDocument": -1}, {"sourceDocument": 1}, {"sourceDocument": 0, "deleted": True}, {"sourceDocument": 0, "sourcePage": 0}]:
        with pytest.raises(core.PdfToolError):
            core.parse_edits(json.dumps([payload() | patch]), 2, 0, 1)
    # Pages of the other PDF are checked when it is opened, not against the edited PDF's page count.
    [parsed] = core.parse_edits(json.dumps([payload() | {"sourceDocument": 0, "sourcePage": 9}]), 2, 0, 1)
    assert parsed == core.RegionEdit(page=1, source_document=0, source_page=9, copy=True, source=(30, 60, 70, 60), x=160, y=200, width=100, height=80)
    [parsed] = core.parse_edits(json.dumps([payload() | {"sourceDocument": 0}]), 2, 0, 1)
    assert parsed.source_page == 1 and parsed.copy


def test_copy_from_another_pdf_api_takes_sources_and_their_passwords():
    edits = [payload() | {"sourceDocument": 0, "sourcePage": 1, "page": 2, "x": 20, "y": 30}]
    with TestClient(app) as client:
        files = [("file", ("target.pdf", destination(), "application/pdf")), ("sources", ("other.pdf", document(password="secret"), "application/pdf"))]
        response = client.post("/api/edit", files=files, data={"edits": json.dumps(edits), "source_passwords": json.dumps(["secret"])})
        assert response.status_code == 200, response.text
        assert 'filename="target_edited.pdf"' in response.headers["content-disposition"]
        with pikepdf.open(BytesIO(response.content)) as pdf:
            assert b"Move this text" in next(iter(pdf.pages[1].Resources.XObject.values())).read_bytes()
        response = client.post("/api/edit", files=files, data={"edits": json.dumps(edits)})
        assert response.status_code == 400
        assert response.json() == {"detail": "other.pdf is password-protected."}
        response = client.post("/api/edit", files=files, data={"edits": json.dumps(edits), "source_passwords": json.dumps(["a", "b"])})
        assert response.status_code == 400
        assert "one password per source PDF" in response.json()["detail"]
        response = client.post("/api/edit", files=files[:1], data={"edits": json.dumps(edits)})
        assert response.status_code == 400
        assert response.json() == {"detail": "Edit 1 refers to a source PDF that wasn't uploaded."}
