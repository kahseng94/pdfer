"""Embedded fonts for text edits beyond the standard ones."""

import sys
from io import BytesIO

import pikepdf
import pytest
from conftest import instructions, make_pdf
from fontTools.ttLib import TTFont

from pdfer import core, fonts


class TestRegistry:
    def test_bundled_fonts(self):
        assert set(fonts.fonts()) >= {"DejaVuSans.ttf", "DejaVuSerif.ttf", "DejaVuSansMono.ttf"}

    def test_chains_fall_back_to_sans(self):
        assert [f.name for f in fonts.chain("sans")][:1] == ["DejaVuSans.ttf"]
        assert [f.name for f in fonts.chain("serif")][:2] == ["DejaVuSerif.ttf", "DejaVuSans.ttf"]
        assert [f.name for f in fonts.chain("mono")][:2] == ["DejaVuSansMono.ttf", "DejaVuSans.ttf"]

    def test_coverage_is_sorted_inclusive_ranges(self):
        cov = fonts.coverage()
        assert cov[0] == (32, 126)
        assert all(a <= b for a, b in cov)
        assert all(cov[i][1] < cov[i + 1][0] - 1 for i in range(len(cov) - 1))

        def has(code: int) -> bool:
            return any(a <= code <= b for a, b in cov)

        assert has(ord("Ж")) and has(ord("λ")) and has(ord("€"))
        assert not has(ord("你"))

    def test_pick(self):
        assert fonts.pick("serif", "Ж").name == "DejaVuSerif.ttf"
        assert fonts.pick("sans", "你") is None


class TestEmbed:
    def test_type0_font_with_subset(self):
        font = fonts.fonts()["DejaVuSans.ttf"]
        pdf = pikepdf.new()
        d = font.embed(pdf, "Привет")
        assert d.Subtype == pikepdf.Name.Type0
        assert d.Encoding == pikepdf.Name("/Identity-H")
        assert str(d.BaseFont).endswith("+DejaVuSans") and len(str(d.BaseFont)) == len("/ABCDEF+DejaVuSans")
        cid = d.DescendantFonts[0]
        assert cid.Subtype == pikepdf.Name.CIDFontType2
        assert cid.CIDToGIDMap == pikepdf.Name.Identity
        assert cid.DW == 1000
        assert len(cid.W) == 2 * 6  # one gid [width] pair per character
        data = cid.FontDescriptor.FontFile2.read_bytes()
        assert len(data) < font.path.stat().st_size // 20
        subset = TTFont(BytesIO(data))
        cmap = subset.getBestCmap()
        assert ord("П") in cmap and ord("A") not in cmap
        # Glyph ids are kept, so the Identity map in the PDF still points at the right glyphs.
        assert subset.getGlyphID(cmap[ord("П")]) == font.glyph_id("П")

    def test_to_unicode_maps_glyphs_back(self):
        font = fonts.fonts()["DejaVuSans.ttf"]
        pdf = pikepdf.new()  # kept alive: the streams below belong to it
        d = font.embed(pdf, "Ж€")
        cmap = d.ToUnicode.read_bytes().decode()
        assert f"<{font.glyph_id('Ж'):04X}> <0416>" in cmap
        assert f"<{font.glyph_id('€'):04X}> <20AC>" in cmap

    def test_encode_is_two_bytes_per_glyph(self):
        font = fonts.fonts()["DejaVuSans.ttf"]
        assert font.encode("Жa") == font.glyph_id("Ж").to_bytes(2, "big") + font.glyph_id("a").to_bytes(2, "big")


class TestEditWithEmbeddedFonts:
    def page(self) -> bytes:
        return make_pdf([300])

    def test_cyrillic_text_is_embedded(self):
        text = core.TextEdit(page=1, x=10, y=20, text="Привет\nмир", size=12, color=(0, 0, 1), family="serif")
        out = core.edit(self.page(), [text])
        found = instructions(out)
        assert [op for _, op in found if op in ("Tf", "Tj", "Tm", "Td", "T*")] == ["Tm", "Tf", "Tj", "Tm", "Tf", "Tj"]
        assert ([1, 0, 0, 1, 10, 200 - 20 - 12 * 0.9], "Tm") in found
        with pikepdf.open(BytesIO(out)) as pdf:
            (font,) = pdf.pages[0].Resources.Font.values()
            assert font.Subtype == pikepdf.Name.Type0
            assert str(font.BaseFont).endswith("+DejaVuSerif")
            assert "/FontFile2" in font.DescendantFonts[0].FontDescriptor
            # Six letters are shared between the two words, so nine glyphs in all.
            assert len(font.DescendantFonts[0].W) == 2 * len(set("Приветмир"))

    def test_latin_text_still_uses_standard_fonts(self):
        text = core.TextEdit(page=1, x=0, y=0, text="Héllo", size=12, color=(0, 0, 0))
        out = core.edit(self.page(), [text])
        with pikepdf.open(BytesIO(out)) as pdf:
            (font,) = pdf.pages[0].Resources.Font.values()
            assert font.Subtype == pikepdf.Name.Type1
            assert font.BaseFont == pikepdf.Name("/Helvetica")

    def test_mixed_scripts_switch_fonts_within_a_line(self):
        # A character Sans has but Mono lacks makes Sans step in for just that stretch.
        mono, sans = fonts.fonts()["DejaVuSansMono.ttf"], fonts.fonts()["DejaVuSans.ttf"]
        rare = chr(next(code for code in sorted(sans.cmap) if code > 0x400 and code not in mono.cmap))
        text = core.TextEdit(page=1, x=0, y=0, text=f"Ж{rare}Ж", size=12, color=(0, 0, 0), family="mono")
        out = core.edit(self.page(), [text])
        found = instructions(out)
        assert [op for _, op in found if op in ("Tf", "Tj")] == ["Tf", "Tj"] * 3
        with pikepdf.open(BytesIO(out)) as pdf:
            names = sorted(str(f.BaseFont).split("+")[1] for f in pdf.pages[0].Resources.Font.values())
        assert names == ["DejaVuSans", "DejaVuSansMono"]

    def test_fake_bold_and_italic(self):
        text = core.TextEdit(page=1, x=5, y=0, text="Ж", size=10, color=(1, 0, 0), bold=True, italic=True)
        found = instructions(core.edit(self.page(), [text]))
        assert ([2], "Tr") in found
        assert ([0.4], "w") in found
        assert ([1, 0, 0], "RG") in found
        assert ([1, 0, 0.25, 1, 5, 200 - 9], "Tm") in found

    def test_one_embedded_font_for_the_whole_document(self):
        edits = [core.TextEdit(page=p, x=0, y=0, text="Ж", size=10, color=(0, 0, 0)) for p in (1, 2)]
        out = core.edit(make_pdf([101, 102]), edits)
        with pikepdf.open(BytesIO(out)) as pdf:
            objs = [next(iter(pdf.pages[i].Resources.Font.values())).objgen for i in (0, 1)]
        assert objs[0] == objs[1]

    def test_character_no_font_has(self):
        text = core.TextEdit(page=1, x=0, y=0, text="hi 你", size=10, color=(0, 0, 0))
        with pytest.raises(core.PdfToolError, match='"你" can\'t be written: no font in pdfer has it'):
            core.edit(self.page(), [text])

    def test_saved_file_stays_small(self):
        text = core.TextEdit(page=1, x=0, y=0, text="Привет, мир! Γειά σου κόσμε", size=10, color=(0, 0, 0))
        out = core.edit(self.page(), [text])
        assert len(out) < 40_000


def test_font_endpoints():
    from fastapi.testclient import TestClient

    from pdfer.api import app

    client = TestClient(app)
    res = client.get("/api/fonts")
    assert res.status_code == 200
    body = res.json()
    assert body["families"]["sans"][0] == "DejaVuSans.ttf"
    assert body["families"]["serif"][:2] == ["DejaVuSerif.ttf", "DejaVuSans.ttf"]
    assert [32, 126] in body["coverage"]

    res = client.get("/api/fonts/DejaVuSans.ttf")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("font/ttf")
    assert res.content[:4] == b"\x00\x01\x00\x00"
    assert "max-age" in res.headers["cache-control"]

    assert client.get("/api/fonts/nope.ttf").status_code == 404
    assert client.get("/api/fonts/..%2F..%2Fpyproject.toml").status_code == 404


def test_edit_endpoint_accepts_cyrillic():
    import json

    from fastapi.testclient import TestClient

    from pdfer.api import app

    client = TestClient(app)
    edits = [{"type": "text", "page": 1, "x": 10, "y": 20, "text": "Привет", "size": 12, "color": "#000000"}]
    res = client.post(
        "/api/edit",
        files={"file": ("a.pdf", make_pdf([101]), "application/pdf")},
        data={"edits": json.dumps(edits)},
    )
    assert res.status_code == 200
    with pikepdf.open(BytesIO(res.content)) as pdf:
        assert any(f.Subtype == pikepdf.Name.Type0 for f in pdf.pages[0].Resources.Font.values())


if __name__ == "__main__":
    sys.exit(pytest.main([__file__]))
