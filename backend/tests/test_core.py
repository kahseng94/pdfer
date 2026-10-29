import json
import re
from io import BytesIO

import pikepdf
import pytest
from conftest import images, instructions, make_image, make_image_pdf, make_pdf, rotations, widths, xobjects
from PIL import Image, ImageDraw

from pdfer import core


class TestParseRanges:
    @pytest.mark.parametrize(
        ("spec", "expected"),
        [
            ("1-3, 5, 8-10", [(1, 3), (5, 5), (8, 10)]),
            ("7-", [(7, 10)]),
            ("-2", [(1, 2)]),
            (" 4 - 6 ,, 9 ", [(4, 6), (9, 9)]),
            ("3,3", [(3, 3), (3, 3)]),
        ],
    )
    def test_valid(self, spec, expected):
        assert core.parse_ranges(spec, 10) == expected

    @pytest.mark.parametrize(
        ("spec", "message"),
        [
            ("", "at least one"),
            (" , ", "at least one"),
            ("abc", "isn't a page"),
            ("-", "isn't a page"),
            ("1-2-3", "isn't a page"),
            ("0", "outside pages 1-10"),
            ("11", "outside pages 1-10"),
            ("5-12", "outside pages 1-10"),
            ("6-2", "backwards"),
        ],
    )
    def test_invalid(self, spec, message):
        with pytest.raises(core.PdfToolError, match=message):
            core.parse_ranges(spec, 10)


class TestMerge:
    def test_keeps_order(self):
        a = make_pdf([101, 102])
        b = make_pdf([201])
        c = make_pdf([301, 302, 303])
        merged = core.merge([("c.pdf", c), ("a.pdf", a), ("b.pdf", b)])
        assert widths(merged) == [301, 302, 303, 101, 102, 201]

    def test_same_file_twice(self):
        a = make_pdf([101, 102])
        assert widths(core.merge([("a.pdf", a), ("a.pdf", a)])) == [101, 102, 101, 102]

    def test_needs_two_files(self):
        with pytest.raises(core.PdfToolError, match="at least two"):
            core.merge([("a.pdf", make_pdf([101]))])

    def test_invalid_pdf_names_the_file(self):
        with pytest.raises(core.PdfToolError, match="notes.txt isn't a valid PDF"):
            core.merge([("a.pdf", make_pdf([101])), ("notes.txt", b"hello")])

    def test_password_protected(self):
        locked = make_pdf([101], password="secret")
        with pytest.raises(core.PdfToolError, match="locked.pdf is password-protected"):
            core.merge([("a.pdf", make_pdf([101])), ("locked.pdf", locked)])


class TestSplit:
    def test_one_file_per_range(self, ten_pages):
        parts = core.split(ten_pages, [(1, 3), (5, 5), (8, 10)])
        assert [widths(p) for p in parts] == [[101, 102, 103], [105], [108, 109, 110]]

    def test_page_count(self, ten_pages):
        assert core.page_count(ten_pages) == 10


class TestExtract:
    def test_combines_ranges_in_order(self, ten_pages):
        out = core.extract(ten_pages, [(9, 10), (2, 2), (2, 3)])
        assert widths(out) == [109, 110, 102, 102, 103]


class TestParsePageOps:
    @pytest.mark.parametrize(
        ("spec", "expected"),
        [
            ("3:90, 1, 2:180", [(3, 90), (1, 0), (2, 180)]),
            (" 4 : 270 ,, 4 ", [(4, 270), (4, 0)]),
            ("5:0", [(5, 0)]),
        ],
    )
    def test_valid(self, spec, expected):
        assert core.parse_page_ops(spec, 10) == expected

    @pytest.mark.parametrize(
        ("spec", "message"),
        [
            ("", "at least one"),
            (" , ", "at least one"),
            ("abc", "isn't a page"),
            ("1-3", "isn't a page"),
            ("2:", "isn't a page"),
            (":90", "isn't a page"),
            ("2:-90", "isn't a page"),
            ("0", "outside pages 1-10"),
            ("11:90", "outside pages 1-10"),
            ("2:45", "0, 90, 180 or 270"),
        ],
    )
    def test_invalid(self, spec, message):
        with pytest.raises(core.PdfToolError, match=message):
            core.parse_page_ops(spec, 10)


class TestOrganize:
    def test_reorders_and_drops_pages(self, ten_pages):
        out = core.organize(ten_pages, [(10, 0), (2, 0), (7, 0)])
        assert widths(out) == [110, 102, 107]
        assert rotations(out) == [0, 0, 0]

    def test_rotates_pages(self, ten_pages):
        out = core.organize(ten_pages, [(1, 90), (2, 0), (3, 270)])
        assert rotations(out) == [90, 0, 270]

    def test_rotation_adds_to_existing(self):
        src = make_pdf([101, 102], rotations=[90, 270])
        out = core.organize(src, [(1, 90), (2, 180)])
        assert rotations(out) == [180, 90]

    def test_same_page_twice_with_different_rotations(self, ten_pages):
        out = core.organize(ten_pages, [(4, 90), (4, 0), (4, 180)])
        assert widths(out) == [104, 104, 104]
        assert rotations(out) == [90, 0, 180]

    def test_needs_a_page(self, ten_pages):
        with pytest.raises(core.PdfToolError, match="at least one"):
            core.organize(ten_pages, [])

    def test_page_out_of_range(self, ten_pages):
        with pytest.raises(core.PdfToolError, match="outside pages 1-10"):
            core.organize(ten_pages, [(1, 0), (11, 0)])

    def test_bad_rotation(self, ten_pages):
        with pytest.raises(core.PdfToolError, match="0, 90, 180 or 270"):
            core.organize(ten_pages, [(1, 45)])


class TestImagesToPdf:
    def test_one_page_per_image_in_order(self):
        out = core.images_to_pdf([("a.png", make_image(96, 192)), ("b.jpg", make_image(192, 96, "JPEG"))])
        assert widths(out) == [72, 144]
        assert rotations(out) == [0, 0]

    def test_png_with_transparency(self):
        out = core.images_to_pdf([("a.png", make_image(96, 96, mode="RGBA"))])
        assert widths(out) == [72]

    def test_exif_orientation_is_honoured(self):
        exif = Image.Exif()
        exif[0x0112] = 6  # rotate 90 degrees clockwise to display
        out = core.images_to_pdf([("photo.jpg", make_image(192, 96, "JPEG", exif=exif.tobytes()))])
        with pikepdf.open(BytesIO(out)) as pdf:
            page = pdf.pages[0]
            w, h = (float(x) for x in page.mediabox[2:])
            if int(page.get("/Rotate", 0)) % 180:
                w, h = h, w
        assert h == 2 * w  # displayed upright, twice as tall as wide

    def test_not_an_image_names_the_file(self):
        with pytest.raises(core.PdfToolError, match="notes.txt isn't an image"):
            core.images_to_pdf([("a.png", make_image(10, 10)), ("notes.txt", b"hello")])

    def test_needs_an_image(self):
        with pytest.raises(core.PdfToolError, match="at least one"):
            core.images_to_pdf([])


class TestCompress:
    @pytest.mark.parametrize(("level", "max_side"), [("balanced", 1600), ("strong", 1000)])
    def test_reencodes_images_as_smaller_jpegs(self, image_pdf, level, max_side):
        out = core.compress(image_pdf, level)
        assert len(out) < len(image_pdf) // 4
        assert core.page_count(out) == 1
        assert images(out) == [("/DCTDecode", max_side, max_side, "/DeviceRGB")]

    def test_strong_is_smaller_than_balanced(self, image_pdf):
        assert len(core.compress(image_pdf, "strong")) < len(core.compress(image_pdf, "balanced"))

    def test_light_keeps_images_as_they_are(self, image_pdf):
        out = core.compress(image_pdf, "light")
        assert len(out) <= len(image_pdf)
        assert images(out) == [("/FlateDecode", 2500, 2500, "/DeviceRGB")]

    def test_light_on_tiny_blank_pdf_is_no_larger(self):
        tiny = make_pdf([101])
        out = core.compress(tiny, "light")
        assert len(out) <= len(tiny)
        assert core.page_count(out) == 1

    def test_image_inside_form_xobject(self):
        src = make_image_pdf(side=1200, nested=True)
        out = core.compress(src, "strong")
        assert len(out) < len(src) // 4
        assert images(out) == [("/DCTDecode", 1000, 1000, "/DeviceRGB")]

    def test_masked_image_is_left_alone(self):
        src = make_image_pdf(side=800, smask=True)
        out = core.compress(src, "strong")
        assert images(out) == [("/FlateDecode", 800, 800, "/DeviceRGB")]

    def test_invalid_pdf_names_the_file(self):
        with pytest.raises(core.PdfToolError, match="bad.pdf isn't a valid PDF"):
            core.compress(b"nope", "balanced", "bad.pdf")

    def test_password_protected(self):
        with pytest.raises(core.PdfToolError, match="locked.pdf is password-protected"):
            core.compress(make_pdf([101], password="secret"), "light", "locked.pdf")

    def test_unknown_level(self, image_pdf):
        with pytest.raises(core.PdfToolError, match="isn't a compression level"):
            core.compress(image_pdf, "extreme")  # type: ignore[arg-type]


EDITS = [
    {"type": "text", "page": 1, "x": 10, "y": 20, "text": "Hi", "size": 12, "color": "#ff0000", "bold": True},
    {"type": "image", "page": 2, "x": 1, "y": 2, "width": 3, "height": 4, "image": 0},
    {"type": "rect", "page": 1, "x": 0, "y": 0, "width": 5, "height": 6, "stroke": "#000000", "strokeWidth": 2},
    {"type": "ellipse", "page": 1, "x": 0, "y": 0, "width": 5, "height": 6, "stroke": None, "fill": "#00ff00"},
    {"type": "highlight", "page": 3, "x": 0, "y": 0, "width": 7, "height": 8, "color": "#ffff00"},
    {"type": "line", "page": 1, "x1": 0, "y1": 1, "x2": 2, "y2": 3, "stroke": "#0000ff", "strokeWidth": 1.5},
    {"type": "draw", "page": 1, "points": [[0, 0], [1.5, 2]], "stroke": "#0000ff", "strokeWidth": 3},
]


class TestParseEdits:
    def test_every_kind(self):
        edits = core.parse_edits(json.dumps(EDITS), 3, 1)
        assert edits == [
            core.TextEdit(page=1, x=10, y=20, text="Hi", size=12, color=(1, 0, 0), bold=True),
            core.ImageEdit(page=2, x=1, y=2, width=3, height=4, image=0),
            core.ShapeEdit(page=1, shape="rect", x=0, y=0, width=5, height=6, stroke=(0, 0, 0), stroke_width=2, fill=None),
            core.ShapeEdit(
                page=1, shape="ellipse", x=0, y=0, width=5, height=6, stroke=None, stroke_width=0, fill=(0, 1, 0)
            ),
            core.HighlightEdit(page=3, x=0, y=0, width=7, height=8, color=(1, 1, 0)),
            core.LineEdit(page=1, x1=0, y1=1, x2=2, y2=3, stroke=(0, 0, 1), stroke_width=1.5),
            core.DrawEdit(page=1, points=((0, 0), (1.5, 2)), stroke=(0, 0, 1), stroke_width=3),
        ]

    def test_text_defaults(self):
        spec = json.dumps([{"type": "text", "page": 1, "x": 0, "y": 0, "text": "x", "size": 9, "color": "#336699"}])
        (edit,) = core.parse_edits(spec, 1)
        assert isinstance(edit, core.TextEdit)
        assert (edit.family, edit.bold, edit.italic) == ("sans", False, False)
        assert edit.color == (0.2, 0.4, 0.6)

    @pytest.mark.parametrize(
        ("spec", "message"),
        [
            ("nope", "valid JSON"),
            ("{}", "must be a list"),
            ("[]", "at least one"),
            ("[1]", "Edit 1 isn't an object"),
            ('[{"type": "blob", "page": 1}]', '"type" must be one of'),
            ('[{"type": "text", "page": 4}]', '"page" is outside pages 1-3'),
            ('[{"type": "text", "page": "1"}]', '"page" is outside pages 1-3'),
            ('[{"type": "text", "page": 1, "x": 0, "y": 0, "text": "hi", "size": 12}]', 'missing "color"'),
            ('[{"type": "text", "page": 1, "x": 0, "y": 0, "text": "hi", "size": 12, "color": "red"}]', "colour like"),
            ('[{"type": "text", "page": 1, "x": "0", "y": 0, "text": "hi", "size": 12, "color": "#000000"}]', '"x" must be a number'),
            ('[{"type": "text", "page": 1, "x": 0, "y": 0, "text": 5, "size": 12, "color": "#000000"}]', '"text" must be text'),
            ('[{"type": "text", "page": 1, "x": 0, "y": 0, "text": "hi", "size": 0, "color": "#000000"}]', '"size" must be a number from 1'),
            ('[{"type": "text", "page": 1, "x": 0, "y": 0, "text": "hi", "size": 12, "color": "#000000", "bold": 1}]', "true or false"),
            ('[{"type": "image", "page": 1, "x": 0, "y": 0, "width": 1, "height": 1, "image": 0}]', "wasn't uploaded"),
            ('[{"type": "rect", "page": 1, "x": 0, "y": 0, "width": 0, "height": 1, "stroke": "#000000", "strokeWidth": 1}]', '"width" must be more than 0'),
            ('[{"type": "rect", "page": 1, "x": 0, "y": 0, "width": 1, "height": 1}]', "needs a stroke or a fill"),
            ('[{"type": "line", "page": 1, "x1": 0, "y1": 0, "x2": 1, "y2": 1, "stroke": "#000000", "strokeWidth": 0}]', '"strokeWidth" must be more than 0'),
            ('[{"type": "draw", "page": 1, "points": [], "stroke": "#000000", "strokeWidth": 1}]', "[x, y] pairs"),
            ('[{"type": "draw", "page": 1, "points": [[1]], "stroke": "#000000", "strokeWidth": 1}]', "[x, y] pairs"),
        ],
    )
    def test_invalid(self, spec, message):
        with pytest.raises(core.PdfToolError, match=re.escape(message)):
            core.parse_edits(spec, 3, 0)

    def test_second_edit_is_named_in_errors(self):
        spec = json.dumps([EDITS[2], {"type": "line", "page": 1}])
        with pytest.raises(core.PdfToolError, match='Edit 2 is missing "x1"'):
            core.parse_edits(spec, 1)


def page_with_content(width: int, height: int, content: bytes, rotate: int = 0, cropbox: list[int] | None = None) -> bytes:
    with pikepdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(width, height))
        page.Contents = pdf.make_stream(content)
        if rotate:
            page.Rotate = rotate
        if cropbox:
            page.CropBox = cropbox
        buf = BytesIO()
        pdf.save(buf)
        return buf.getvalue()


def ops(data: bytes, page: int = 0) -> list[str]:
    return [op for _, op in instructions(data, page)]


class TestEdit:
    def test_draws_after_existing_content(self):
        src = page_with_content(300, 500, b"0 0 1 rg 0 0 10 10 re f")
        out = core.edit(src, [core.LineEdit(page=1, x1=0, y1=0, x2=10, y2=20, stroke=(0, 0, 0), stroke_width=1)])
        found = instructions(out)
        # The old content is wrapped in q/Q, then the edits are drawn in the display frame.
        assert ops(out) == ["q", "rg", "re", "f", "Q", "q", "cm", "q", "RG", "w", "J", "j", "m", "l", "S", "Q", "Q"]
        assert found[6] == ([1, 0, 0, 1, 0, 0], "cm")
        # y runs down from the top on the way in and up from the bottom in the stream.
        assert found[12] == ([0, 500], "m")
        assert found[13] == ([10, 480], "l")

    def test_rotated_page_is_drawn_as_displayed(self):
        # A 300 x 500 page turned 90 degrees shows as 500 wide and 300 tall.
        src = page_with_content(300, 500, b"", rotate=90)
        rect = core.ShapeEdit(page=1, shape="rect", x=10, y=20, width=30, height=40, stroke=(0, 0, 0), stroke_width=1, fill=None)
        found = instructions(core.edit(src, [rect]))
        assert ([0, 1, -1, 0, 300, 0], "cm") in found
        assert ([10, 300 - 20 - 40, 30, 40], "re") in found

    @pytest.mark.parametrize(("rotate", "matrix"), [(180, [-1, 0, 0, -1, 300, 500]), (270, [0, -1, 1, 0, 0, 500]), (-90, [0, -1, 1, 0, 0, 500])])
    def test_other_rotations(self, rotate, matrix):
        src = page_with_content(300, 500, b"", rotate=rotate)
        out = core.edit(src, [core.LineEdit(page=1, x1=0, y1=0, x2=1, y2=1, stroke=(0, 0, 0), stroke_width=1)])
        assert (matrix, "cm") in instructions(out)

    def test_crop_box_moves_the_origin(self):
        src = page_with_content(300, 500, b"", cropbox=[10, 20, 200, 400])
        out = core.edit(src, [core.LineEdit(page=1, x1=0, y1=0, x2=190, y2=380, stroke=(0, 0, 0), stroke_width=1)])
        found = instructions(out)
        assert ([1, 0, 0, 1, 10, 20], "cm") in found
        assert ([0, 380], "m") in found
        assert ([190, 0], "l") in found

    def test_text(self):
        text = core.TextEdit(page=1, x=10, y=20, text="Héllo\n\nworld", size=10, color=(1, 0, 0), family="serif", bold=True, italic=True)
        out = core.edit(page_with_content(300, 500, b""), [text])
        found = instructions(out)
        assert [op for _, op in found if op in ("BT", "Tf", "rg", "TL", "Td", "Tj", "T*", "ET")] == [
            "BT", "Tf", "rg", "TL", "Td", "Tj", "T*", "Tj", "T*", "Tj", "ET",
        ]
        assert [o for o, op in found if op == "Tj"] == [["Héllo"], [""], ["world"]]
        assert ([12], "TL") in found  # 1.2 em between lines
        assert ([10, 500 - 20 - 9], "Td") in found  # first baseline 0.9 em below the top of the box
        with pikepdf.open(BytesIO(out)) as pdf:
            fonts = [dict(f) for f in pdf.pages[0].Resources.Font.values()]
        assert len(fonts) == 1
        assert fonts[0]["/BaseFont"] == pikepdf.Name("/Times-BoldItalic")
        assert fonts[0]["/Encoding"] == pikepdf.Name("/WinAnsiEncoding")

    def test_text_no_font_can_write(self):
        text = core.TextEdit(page=1, x=0, y=0, text="hi 你", size=10, color=(0, 0, 0))
        with pytest.raises(core.PdfToolError, match='"你" can\'t be written'):
            core.edit(page_with_content(300, 500, b""), [text])

    def test_text_control_characters(self):
        text = core.TextEdit(page=1, x=0, y=0, text="a\tb", size=10, color=(0, 0, 0))
        with pytest.raises(core.PdfToolError, match="control characters"):
            core.edit(page_with_content(300, 500, b""), [text])

    def test_jpeg_is_embedded_as_it_is(self):
        image = core.ImageEdit(page=1, x=5, y=6, width=20, height=10, image=0)
        out = core.edit(page_with_content(300, 500, b""), [image], [("p.jpg", make_image(8, 4, "JPEG"))])
        assert xobjects(out) == [("/DCTDecode", 8, 4, "/DeviceRGB", False)]
        assert ([20, 0, 0, 10, 5, 500 - 6 - 10], "cm") in instructions(out)
        assert ops(out).count("Do") == 1

    def test_png_with_transparency_gets_a_soft_mask(self):
        image = core.ImageEdit(page=1, x=0, y=0, width=1, height=1, image=0)
        out = core.edit(page_with_content(300, 500, b""), [image], [("a.png", make_image(8, 4, mode="RGBA"))])
        assert xobjects(out) == [("/FlateDecode", 8, 4, "/DeviceRGB", True)]

    def test_exif_orientation_is_honoured(self):
        exif = Image.Exif()
        exif[0x0112] = 6  # rotate 90 degrees clockwise to display
        image = core.ImageEdit(page=1, x=0, y=0, width=1, height=1, image=0)
        photo = make_image(8, 4, "JPEG", exif=exif.tobytes())
        out = core.edit(page_with_content(300, 500, b""), [image], [("p.jpg", photo)])
        assert xobjects(out) == [("/FlateDecode", 4, 8, "/DeviceRGB", False)]

    def test_image_shared_between_pages(self):
        edits = [core.ImageEdit(page=p, x=0, y=0, width=1, height=1, image=0) for p in (1, 2)]
        out = core.edit(make_pdf([101, 102]), edits, [("a.png", make_image(2, 2))])
        with pikepdf.open(BytesIO(out)) as pdf:
            streams = [next(iter(pdf.pages[i].Resources.XObject.values())) for i in (0, 1)]
            assert streams[0].objgen == streams[1].objgen

    def test_not_an_image_names_the_file(self):
        image = core.ImageEdit(page=1, x=0, y=0, width=1, height=1, image=0)
        with pytest.raises(core.PdfToolError, match="notes.txt isn't an image"):
            core.edit(make_pdf([101]), [image], [("notes.txt", b"hello")])

    def test_image_not_provided(self):
        image = core.ImageEdit(page=1, x=0, y=0, width=1, height=1, image=2)
        with pytest.raises(core.PdfToolError, match="wasn't provided"):
            core.edit(make_pdf([101]), [image], [("a.png", make_image(2, 2))])

    def test_highlight_multiplies_with_the_page(self):
        out = core.edit(make_pdf([101]), [core.HighlightEdit(page=1, x=1, y=2, width=3, height=4, color=(1, 1, 0))])
        found = instructions(out)
        assert [op for _, op in found if op in ("gs", "rg", "re", "f")] == ["gs", "rg", "re", "f"]
        assert ([1, 200 - 2 - 4, 3, 4], "re") in found
        with pikepdf.open(BytesIO(out)) as pdf:
            states = [dict(g) for g in pdf.pages[0].Resources.ExtGState.values()]
        assert states == [{"/Type": pikepdf.Name.ExtGState, "/BM": pikepdf.Name.Multiply}]

    def test_shapes(self):
        shapes = [
            core.ShapeEdit(page=1, shape="rect", x=1, y=2, width=3, height=4, stroke=(0, 0, 0), stroke_width=2, fill=(1, 1, 1)),
            core.ShapeEdit(page=1, shape="ellipse", x=0, y=0, width=10, height=20, stroke=None, stroke_width=0, fill=(0, 0, 1)),
        ]
        found = instructions(core.edit(make_pdf([101]), shapes))
        assert [op for _, op in found if op in ("re", "B", "m", "c", "h", "f", "S")] == ["re", "B", "m", "c", "c", "c", "c", "h", "f"]
        assert ([10, 190], "m") in found  # the ellipse starts at its rightmost point, halfway down

    def test_single_point_stroke_is_a_dot(self):
        found = instructions(core.edit(make_pdf([101]), [core.DrawEdit(page=1, points=((3, 4),), stroke=(0, 0, 0), stroke_width=2)]))
        assert ([3, 196], "m") in found
        assert ([3, 196], "l") in found
        assert ([1], "J") in found  # round caps

    def test_untouched_pages_keep_their_content(self, ten_pages):
        out = core.edit(ten_pages, [core.HighlightEdit(page=2, x=0, y=0, width=1, height=1, color=(1, 1, 0))])
        assert widths(out) == widths(ten_pages)
        assert ops(out, 0) == []
        assert "re" in ops(out, 1)

    def test_page_out_of_range(self, ten_pages):
        with pytest.raises(core.PdfToolError, match="outside pages 1-10"):
            core.edit(ten_pages, [core.HighlightEdit(page=11, x=0, y=0, width=1, height=1, color=(1, 1, 0))])

    def test_needs_an_edit(self, ten_pages):
        with pytest.raises(core.PdfToolError, match="at least one"):
            core.edit(ten_pages, [])

    def test_invalid_pdf_names_the_file(self):
        with pytest.raises(core.PdfToolError, match="bad.pdf isn't a valid PDF"):
            core.edit(b"nope", [core.HighlightEdit(page=1, x=0, y=0, width=1, height=1, color=(1, 1, 0))], name="bad.pdf")


# --- Photo -------------------------------------------------------------------


def quadrants(width: int = 400, height: int = 300, fmt: str = "PNG", **save) -> bytes:
    """An image whose quadrants are red, green (top), blue and yellow (bottom)."""
    img = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(img)
    w, h = width // 2, height // 2
    draw.rectangle([0, 0, w - 1, h - 1], fill=(255, 0, 0))
    draw.rectangle([w, 0, width - 1, h - 1], fill=(0, 255, 0))
    draw.rectangle([0, h, w - 1, height - 1], fill=(0, 0, 255))
    draw.rectangle([w, h, width - 1, height - 1], fill=(255, 255, 0))
    buf = BytesIO()
    img.save(buf, fmt, **save)
    return buf.getvalue()


def colour(data: bytes, x: int, y: int) -> str:
    r, g, b = Image.open(BytesIO(data)).convert("RGB").getpixel((x, y))
    return {(1, 0, 0): "red", (0, 1, 0): "green", (0, 0, 1): "blue", (1, 1, 0): "yellow", (1, 1, 1): "white"}.get(
        (round(r / 255), round(g / 255), round(b / 255)), f"({r}, {g}, {b})"
    )


class TestPhoto:
    def test_parse_crop(self):
        crop = core.parse_photo_crop('{"cx": 10, "cy": 20.5, "width": 30, "height": 40}')
        assert crop == core.PhotoCrop(10, 20.5, 30, 40, 0)
        assert core.parse_photo_crop('{"cx": 1, "cy": 2, "width": 3, "height": 4, "angle": -7.5}').angle == -7.5

    @pytest.mark.parametrize(
        ("spec", "message"),
        [
            ("nope", "The crop isn't valid JSON."),
            ("[1, 2]", "The crop must be a JSON object."),
            ('{"cx": 1, "cy": 2, "width": 3}', "The crop needs a number for height."),
            ('{"cx": "1", "cy": 2, "width": 3, "height": 4}', "The crop needs a number for cx."),
            ('{"cx": true, "cy": 2, "width": 3, "height": 4}', "The crop needs a number for cx."),
            ('{"cx": 1, "cy": 2, "width": 0, "height": 4}', "The crop's width and height must be more than zero."),
        ],
    )
    def test_parse_crop_errors(self, spec, message):
        with pytest.raises(core.PdfToolError, match=re.escape(message)):
            core.parse_photo_crop(spec)

    def test_crop_is_resampled_to_size_with_dpi(self):
        out = core.crop_photo(quadrants(), core.PhotoCrop(200, 150, 200, 100), (200, 100), dpi=600)
        img = Image.open(BytesIO(out))
        assert img.format == "JPEG"
        assert img.size == (200, 100)
        assert img.info["dpi"] == (600, 600)
        assert [colour(out, x, y) for x, y in [(10, 10), (190, 10), (10, 90), (190, 90)]] == [
            "red",
            "green",
            "blue",
            "yellow",
        ]

    def test_crop_inside_one_quadrant_upscales(self):
        out = core.crop_photo(quadrants(), core.PhotoCrop(100, 75, 20, 20), (120, 120))
        assert Image.open(BytesIO(out)).size == (120, 120)
        assert {colour(out, x, y) for x, y in [(5, 5), (115, 115)]} == {"red"}

    def test_large_crop_is_reduced_first(self):
        # 400x300 crop into 40x30 goes through reduce(); the quadrants must still land in the right corners.
        out = core.crop_photo(quadrants(), core.PhotoCrop(200, 150, 400, 300), (40, 30))
        assert [colour(out, x, y) for x, y in [(2, 2), (37, 2), (2, 27), (37, 27)]] == ["red", "green", "blue", "yellow"]

    def test_angle_turns_the_picture_clockwise(self):
        # Turned 90° clockwise, the red top-left quadrant ends up top-right.
        out = core.crop_photo(quadrants(), core.PhotoCrop(200, 150, 200, 200, angle=90), (200, 200))
        assert [colour(out, x, y) for x, y in [(190, 10), (190, 190), (10, 10), (10, 190)]] == [
            "red",
            "green",
            "blue",
            "yellow",
        ]

    def test_outside_the_picture_is_white(self):
        out = core.crop_photo(quadrants(), core.PhotoCrop(0, 0, 100, 100), (100, 100))
        assert colour(out, 10, 10) == "white"
        assert colour(out, 90, 90) == "red"

    def test_exif_orientation_is_applied_first(self):
        # Orientation 6 shows the picture turned 90° clockwise, so the quadrants come out
        # blue, red (top) and yellow, green (bottom). The crop counts pixels of that view.
        exif = Image.Exif()
        exif[0x0112] = 6
        out = core.crop_photo(quadrants(fmt="JPEG", exif=exif.tobytes()), core.PhotoCrop(150, 200, 300, 400), (30, 40))
        assert [colour(out, x, y) for x, y in [(5, 5), (25, 5), (5, 35), (25, 35)]] == ["blue", "red", "yellow", "green"]

    def test_transparency_is_flattened_onto_white(self):
        out = core.crop_photo(make_image(50, 50, mode="RGBA"), core.PhotoCrop(25, 25, 50, 50), (10, 10))
        r, g, b = Image.open(BytesIO(out)).convert("RGB").getpixel((5, 5))
        # Half-transparent (200, 30, 60) over white.
        assert (abs(r - 227) < 6, abs(g - 142) < 6, abs(b - 157) < 6) == (True, True, True)

    def test_max_bytes_lowers_quality(self):
        noise = Image.merge("RGB", [Image.effect_noise((300, 300), 80) for _ in range(3)])
        buf = BytesIO()
        noise.save(buf, "PNG")
        crop = core.PhotoCrop(150, 150, 300, 300)
        full = core.crop_photo(buf.getvalue(), crop, (300, 300))
        small = core.crop_photo(buf.getvalue(), crop, (300, 300), max_bytes=len(full) // 2)
        assert len(small) <= len(full) // 2

    def test_bad_sizes(self):
        with pytest.raises(core.PdfToolError, match="between 1 and 6000 pixels"):
            core.crop_photo(quadrants(), core.PhotoCrop(1, 1, 1, 1), (0, 10))
        with pytest.raises(core.PdfToolError, match="2400 dpi"):
            core.crop_photo(quadrants(), core.PhotoCrop(1, 1, 1, 1), (10, 10), dpi=0)

    def test_unreadable_photo(self):
        with pytest.raises(core.PdfToolError, match="notes.txt isn't an image pdfer can read."):
            core.crop_photo(b"hello", core.PhotoCrop(1, 1, 1, 1), (10, 10), name="notes.txt")

    @pytest.mark.parametrize(
        ("paper", "photo", "layout"),
        [
            ("4x6", (35, 45), (2, 3, False)),
            ("4x6", (50.8, 50.8), (1, 2, False)),
            ("4x6", (50, 70), (1, 2, False)),
            ("a4", (35, 45), (5, 6, False)),
            ("letter", (35, 45), (7, 4, True)),
            ("4x6", (120, 120), (0, 0, False)),
        ],
    )
    def test_sheet_layout(self, paper, photo, layout):
        assert core.sheet_layout(core.PAPERS[paper], photo) == layout

    def test_photo_sheet(self):
        out, copies = core.photo_sheet(quadrants(), core.PhotoCrop(200, 150, 200, 200), (35, 45), "4x6")
        assert copies == 6
        with pikepdf.open(BytesIO(out)) as pdf:
            assert len(pdf.pages) == 1
            box = [float(v) for v in pdf.pages[0].mediabox]
            assert box[2] == pytest.approx(288, abs=0.5)
            assert box[3] == pytest.approx(432, abs=0.5)
        assert images(out) == [("/DCTDecode", 1200, 1800, "/DeviceRGB")]

    def test_photo_sheet_turns_the_paper_when_that_fits_more(self):
        out, copies = core.photo_sheet(quadrants(), core.PhotoCrop(200, 150, 200, 200), (35, 45), "letter")
        assert copies == 28
        assert widths(out) == [792]

    def test_photo_sheet_errors(self):
        crop = core.PhotoCrop(200, 150, 200, 200)
        with pytest.raises(core.PdfToolError, match="doesn't fit on that paper"):
            core.photo_sheet(quadrants(), crop, (120, 120), "4x6")
        with pytest.raises(core.PdfToolError, match="between 10 and 150 mm"):
            core.photo_sheet(quadrants(), crop, (5, 45), "4x6")
        with pytest.raises(core.PdfToolError, match="Unknown paper size"):
            core.photo_sheet(quadrants(), crop, (35, 45), "b5")  # type: ignore[arg-type]


# --- Compress images ---------------------------------------------------------


def noise(width: int, height: int, fmt: str = "JPEG", mode: str = "RGB", **save) -> bytes:
    """A noisy picture, which no encoder can shrink without losing something."""
    bands = [Image.effect_noise((width, height), 80) for _ in range(len(mode))]
    img = Image.merge(mode, bands)
    buf = BytesIO()
    img.save(buf, fmt, **save)
    return buf.getvalue()


def opened(result: core.CompressedImage) -> Image.Image:
    img = Image.open(BytesIO(result.data))
    img.load()
    return img


class TestCompressImage:
    def test_light_keeps_the_size_and_shrinks(self):
        src = noise(800, 600, quality=97)
        out = core.compress_image("photo.jpg", src, "light")
        assert (out.name, out.media_type, out.before) == ("photo_compressed.jpg", "image/jpeg", len(src))
        assert out.after == len(out.data) < len(src)
        img = opened(out)
        assert (img.format, img.size) == ("JPEG", (800, 600))
        assert "exif" not in img.info

    @pytest.mark.parametrize(("level", "side"), [("balanced", 1600), ("strong", 1000)])
    def test_levels_downscale_the_longer_side(self, level, side):
        out = core.compress_image("big.jpg", noise(2400, 1800, quality=90), level)
        assert opened(out).size == (side, side * 3 // 4)

    def test_small_pictures_are_not_enlarged(self):
        out = core.compress_image("small.jpg", noise(300, 200, quality=95), "strong")
        assert opened(out).size == (300, 200)

    def test_png_with_few_colours_becomes_a_palette_without_loss(self):
        img = Image.new("RGB", (400, 400), (10, 20, 30))
        img.paste((200, 100, 50), (0, 0, 200, 400))
        buf = BytesIO()
        img.save(buf, "PNG")
        out = core.compress_image("flat.png", buf.getvalue(), "light")
        result = opened(out)
        assert (result.format, result.mode) == ("PNG", "P")
        assert out.after < out.before
        assert result.convert("RGB").tobytes() == img.tobytes()

    def test_png_with_many_colours_stays_truecolour_unless_strong(self):
        src = noise(300, 300, "PNG")
        assert opened(core.compress_image("n.png", src, "balanced")).mode == "RGB"
        strong = core.compress_image("n.png", src, "strong")
        assert opened(strong).mode == "P"
        assert strong.after < len(src)

    def test_transparency_survives(self):
        src = noise(200, 200, "PNG", mode="RGBA")
        out = core.compress_image("alpha.png", src, "strong")
        result = opened(out)
        assert result.format == "PNG"
        assert "A" in result.convert("RGBA").getbands() and result.convert("RGBA").getextrema()[3] != (255, 255)
        webp = core.compress_image("alpha.png", src, "light", "webp")
        assert (webp.name, webp.media_type, opened(webp).mode) == ("alpha_compressed.webp", "image/webp", "RGBA")

    def test_keep_returns_the_original_when_nothing_shrinks(self):
        src = make_image(8, 8)  # a flat PNG, already as small as it gets
        out = core.compress_image("tiny.png", src, "light")
        assert out.data == src
        assert (out.before, out.after, out.name, out.media_type) == (len(src), len(src), "tiny_compressed.png", "image/png")

    def test_convert_png_to_jpeg_flattens_onto_white(self):
        src = make_image(50, 50, mode="RGBA")
        out = core.compress_image("half.png", src, "light", "jpeg")
        img = opened(out)
        assert (img.format, out.media_type, out.name) == ("JPEG", "image/jpeg", "half_compressed.jpg")
        r, g, b = img.getpixel((25, 25))
        assert abs(r - 227) < 6 and abs(g - 142) < 6 and abs(b - 157) < 6

    def test_max_bytes_lowers_quality_then_size(self):
        src = noise(1200, 1200, quality=95)
        out = core.compress_image("n.jpg", src, "light", max_bytes=60_000)
        assert out.after <= 60_000
        assert max(opened(out).size) < 1200  # quality alone can't get noise this small

    def test_max_bytes_on_png_goes_to_palette_then_shrinks(self):
        src = noise(600, 600, "PNG")
        out = core.compress_image("n.png", src, "light", max_bytes=100_000)
        assert out.after <= 100_000
        assert opened(out).format == "PNG"

    def test_exif_orientation_is_applied_and_dropped(self):
        exif = Image.Exif()
        exif[0x0112] = 6
        out = core.compress_image("side.jpg", noise(300, 200, quality=95, exif=exif.tobytes()), "light")
        img = opened(out)
        assert img.size == (200, 300)
        assert img.getexif().get(0x0112) is None

    def test_other_formats_keep_sensibly(self):
        out = core.compress_image("pic.bmp", make_image(40, 40, "BMP"), "light")
        assert (out.media_type, out.name) == ("image/jpeg", "pic_compressed.jpg")
        out = core.compress_image("pic.tif", make_image(40, 40, "TIFF", mode="RGBA"), "light")
        assert (out.media_type, out.name) == ("image/png", "pic_compressed.png")

    def test_errors(self):
        with pytest.raises(core.PdfToolError, match="notes.txt isn't an image pdfer can read."):
            core.compress_image("notes.txt", b"hello", "light")
        with pytest.raises(core.PdfToolError, match="isn't a compression level"):
            core.compress_image("a.png", make_image(8, 8), "extreme")  # type: ignore[arg-type]
        with pytest.raises(core.PdfToolError, match="isn't an image format"):
            core.compress_image("a.png", make_image(8, 8), "light", "gif")  # type: ignore[arg-type]
        with pytest.raises(core.PdfToolError, match="at least 1 byte"):
            core.compress_image("a.png", make_image(8, 8), "light", max_bytes=0)
