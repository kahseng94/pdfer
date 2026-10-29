"""Fonts for the text that edits put on pages.

The standard PDF fonts (Helvetica, Times, Courier) need no embedding but only
have Latin letters. Any other text is set in the TrueType fonts in the
``fonts`` directory next to this file, which get embedded in the PDF, subset
to the characters actually used. DejaVu Sans, Serif and Sans Mono come with
pdfer; dropping another ``.ttf`` into the directory, say Noto Sans SC for
Chinese, makes it a further fallback for every family.
"""

from __future__ import annotations

import functools
import hashlib
import threading
from collections.abc import Iterable, Sequence
from io import BytesIO
from pathlib import Path
from typing import Literal

import pikepdf
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

FONT_DIR = Path(__file__).parent / "fonts"

FontFamily = Literal["sans", "serif", "mono"]
FAMILIES: tuple[FontFamily, ...] = ("sans", "serif", "mono")

# The fonts that come with pdfer, per family, in fallback order. Other .ttf
# files in the directory are appended to every family, by name.
_BUNDLED: dict[FontFamily, tuple[str, ...]] = {
    "sans": ("DejaVuSans.ttf",),
    "serif": ("DejaVuSerif.ttf", "DejaVuSans.ttf"),
    "mono": ("DejaVuSansMono.ttf", "DejaVuSans.ttf"),
}

CodeRange = tuple[int, int]
"""First and last code point, inclusive."""


class Font:
    """One TrueType file, read on first use and shared between threads."""

    def __init__(self, path: Path):
        self.path = path
        self.name = path.name
        self._lock = threading.Lock()
        self._ttf: TTFont | None = None

    @property
    def ttf(self) -> TTFont:
        with self._lock:
            if self._ttf is None:
                self._ttf = TTFont(self.path, lazy=True)
                # Touch the tables everything below needs while we hold the lock.
                self._cmap = self._ttf.getBestCmap() or {}
                self._widths = self._ttf["hmtx"].metrics
                self._order = {name: i for i, name in enumerate(self._ttf.getGlyphOrder())}
            return self._ttf

    @property
    def cmap(self) -> dict[int, str]:
        self.ttf
        return self._cmap

    def has(self, ch: str) -> bool:
        return ord(ch) in self.cmap

    def glyph_id(self, ch: str) -> int:
        return self._order[self.cmap[ord(ch)]]

    def width(self, ch: str) -> int:
        """Advance width in 1/1000 em, as PDF wants it."""
        return round(self._widths[self.cmap[ord(ch)]][0] * 1000 / self.ttf["head"].unitsPerEm)

    @property
    def postscript_name(self) -> str:
        name = self.ttf["name"].getDebugName(6) or self.path.stem
        return "".join(ch for ch in name if ch.isalnum() or ch in "-_")

    def subset(self, chars: Iterable[str]) -> bytes:
        """The font with only these characters' glyphs, keeping their glyph ids."""
        # The subsetter changes the font in place, so it gets a copy of its own.
        ttf = TTFont(self.path)
        options = Options()
        options.retain_gids = True  # so /CIDToGIDMap /Identity still holds
        options.notdef_outline = True
        options.hinting = False
        options.glyph_names = False
        options.drop_tables += ["GSUB", "GPOS", "GDEF", "BASE", "JSTF", "DSIG", "FFTM", "morx", "kern"]
        subsetter = Subsetter(options)
        subsetter.populate(text="".join(chars))
        subsetter.subset(ttf)
        out = BytesIO()
        ttf.save(out)
        return out.getvalue()

    def embed(self, pdf: pikepdf.Pdf, chars: Iterable[str], serif: bool = False) -> pikepdf.Dictionary:
        """A Type0 font dictionary for this font subset to `chars`, with glyph ids as codes.

        Text is shown as two-byte glyph ids (Identity-H), and a ToUnicode map
        makes it searchable and copyable.
        """
        used = sorted(set(chars), key=ord)
        data = self.subset(used)
        tag = _subset_tag(self.name, used)
        base = pikepdf.Name(f"/{tag}+{self.postscript_name}")
        ttf = self.ttf
        scale = 1000 / ttf["head"].unitsPerEm
        head, hhea, post = ttf["head"], ttf["hhea"], ttf["post"]
        os2 = ttf["OS/2"] if "OS/2" in ttf else None
        cap_height = os2.sCapHeight if os2 is not None and getattr(os2, "sCapHeight", 0) else hhea.ascent * 0.7
        flags = 4  # symbolic: the codes are glyph ids, not any standard encoding
        if post.isFixedPitch:
            flags |= 1
        if serif:
            flags |= 2

        descriptor = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name.FontDescriptor,
                FontName=base,
                Flags=flags,
                FontBBox=[round(v * scale) for v in (head.xMin, head.yMin, head.xMax, head.yMax)],
                ItalicAngle=float(post.italicAngle),
                Ascent=round(hhea.ascent * scale),
                Descent=round(hhea.descent * scale),
                CapHeight=round(cap_height * scale),
                StemV=80,
                FontFile2=pdf.make_stream(data, Length1=len(data)),
            )
        )
        widths = pikepdf.Array()
        for ch in used:
            widths.append(self.glyph_id(ch))
            widths.append(pikepdf.Array([self.width(ch)]))
        descendant = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name.Font,
                Subtype=pikepdf.Name.CIDFontType2,
                BaseFont=base,
                CIDSystemInfo=pikepdf.Dictionary(
                    Registry=pikepdf.String(b"Adobe"), Ordering=pikepdf.String(b"Identity"), Supplement=0
                ),
                FontDescriptor=descriptor,
                DW=1000,
                W=widths,
                CIDToGIDMap=pikepdf.Name.Identity,
            )
        )
        return pikepdf.Dictionary(
            Type=pikepdf.Name.Font,
            Subtype=pikepdf.Name.Type0,
            BaseFont=base,
            Encoding=pikepdf.Name("/Identity-H"),
            DescendantFonts=[descendant],
            ToUnicode=pdf.make_stream(_to_unicode(self, used)),
        )

    def encode(self, text: str) -> bytes:
        """The text as two-byte glyph ids, for a string operand with this font."""
        return b"".join(self.glyph_id(ch).to_bytes(2, "big") for ch in text)


def _subset_tag(name: str, chars: Sequence[str]) -> str:
    """Six capital letters that identify this subset, as PDF asks of subset fonts."""
    digest = hashlib.sha1((name + "".join(chars)).encode()).digest()
    return "".join(chr(ord("A") + b % 26) for b in digest[:6])


def _to_unicode(font: Font, chars: Sequence[str]) -> bytes:
    lines = [
        "/CIDInit /ProcSet findresource begin",
        "12 dict begin",
        "begincmap",
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
        "/CMapName /Adobe-Identity-UCS def",
        "/CMapType 2 def",
        "1 begincodespacerange",
        "<0000> <FFFF>",
        "endcodespacerange",
    ]
    for start in range(0, len(chars), 100):  # a bfchar block holds at most 100 entries
        chunk = chars[start : start + 100]
        lines.append(f"{len(chunk)} beginbfchar")
        for ch in chunk:
            lines.append(f"<{font.glyph_id(ch):04X}> <{ch.encode('utf-16-be').hex().upper()}>")
        lines.append("endbfchar")
    lines += ["endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end"]
    return "\n".join(lines).encode()


@functools.cache
def fonts() -> dict[str, Font]:
    """Every TrueType font in the directory, by file name."""
    return {path.name: Font(path) for path in sorted(FONT_DIR.glob("*.ttf"))}


@functools.cache
def chain(family: FontFamily) -> tuple[Font, ...]:
    """The fonts to try for a family, in order."""
    available = fonts()
    names = [n for n in _BUNDLED[family] if n in available]
    names += [n for n in available if n not in _BUNDLED["sans"] + _BUNDLED["serif"] + _BUNDLED["mono"]]
    return tuple(available[n] for n in names)


@functools.cache
def coverage() -> list[CodeRange]:
    """The code points some font has, as sorted inclusive ranges."""
    codes: set[int] = set()
    for font in fonts().values():
        codes.update(font.cmap)
    ranges: list[CodeRange] = []
    for code in sorted(codes):
        if ranges and ranges[-1][1] == code - 1:
            ranges[-1] = (ranges[-1][0], code)
        else:
            ranges.append((code, code))
    return ranges


def pick(family: FontFamily, ch: str) -> Font | None:
    """The first font in the family's chain that has the character."""
    for font in chain(family):
        if font.has(ch):
            return font
    return None
