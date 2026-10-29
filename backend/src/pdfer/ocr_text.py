"""Unicode OCR words as an invisible PDF layer, independent of either engine."""

import functools
import math
from decimal import Decimal
from io import BytesIO

import pikepdf
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

from pdfer import core


@functools.lru_cache(maxsize=1)
def _blank_font() -> bytes:
    # OCR is invisible. One empty glyph plus a ToUnicode map supports every
    # recognized script without adding a large visible CJK font dependency.
    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder([".notdef", "blank"])
    builder.setupCharacterMap({32: "blank"})
    builder.setupGlyf({name: TTGlyphPen(None).glyph() for name in (".notdef", "blank")})
    builder.setupHorizontalMetrics({name: (1000, 0) for name in (".notdef", "blank")})
    builder.setupHorizontalHeader(ascent=1000, descent=0)
    builder.setupNameTable({"familyName": "PdferOCR", "styleName": "Regular", "uniqueFontIdentifier": "PdferOCR", "fullName": "PdferOCR", "psName": "PdferOCR"})
    builder.setupOS2(sTypoAscender=1000, sTypoDescender=0, usWinAscent=1000, usWinDescent=0)
    builder.setupPost()
    builder.setupMaxp()
    output = BytesIO()
    builder.save(output)
    return output.getvalue()


def _font(pdf: pikepdf.Pdf, codes: dict[str, int]) -> pikepdf.Object:
    data = _blank_font()
    descriptor = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.FontDescriptor, FontName=pikepdf.Name.PdferOCR,
        Flags=4, FontBBox=[0, 0, 1000, 1000], ItalicAngle=0,
        Ascent=1000, Descent=0, CapHeight=1000, StemV=80,
        FontFile2=pdf.make_stream(data, Length1=len(data)),
    ))
    descendant = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.CIDFontType2, BaseFont=pikepdf.Name.PdferOCR,
        CIDSystemInfo=pikepdf.Dictionary(Registry="Adobe", Ordering="Identity", Supplement=0),
        FontDescriptor=descriptor, DW=1000,
        CIDToGIDMap=pdf.make_stream(b"\0\0" + b"\0\1" * len(codes)),
    ))
    cmap = ["/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap",
            "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
            "/CMapName /PdferOCR-UCS def", "/CMapType 2 def",
            "1 begincodespacerange", "<0000> <FFFF>", "endcodespacerange"]
    entries = list(codes.items())
    for start in range(0, len(entries), 100):
        group = entries[start:start + 100]
        cmap.append(f"{len(group)} beginbfchar")
        cmap.extend(f"<{code:04X}> <{char.encode('utf-16-be').hex().upper()}>" for char, code in group)
        cmap.append("endbfchar")
    cmap += ["endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end"]
    return pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type0, BaseFont=pikepdf.Name.PdferOCR,
        Encoding=pikepdf.Name("/Identity-H"), DescendantFonts=[descendant],
        ToUnicode=pdf.make_stream("\n".join(cmap).encode("ascii")),
    ))


def build(result: object, width: int, height: int, dpi: int) -> bytes:
    """Word quadrilaterals use pixel coordinates with a top-left origin."""
    if not isinstance(result, dict) or result.get("width") != width or result.get("height") != height:
        raise core.PdfToolError("PaddleOCR returned incorrect page dimensions.")
    words = result.get("words")
    if not isinstance(words, list) or len(words) > 50_000:
        raise core.PdfToolError("PaddleOCR returned too many text regions.")
    validated = []
    characters = 0
    for word in words:
        if not isinstance(word, dict) or not isinstance(word.get("text"), str):
            raise core.PdfToolError("PaddleOCR returned an invalid text region.")
        text, polygon = word["text"], word.get("polygon")
        characters += len(text)
        if characters > 500_000 or any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in text):
            raise core.PdfToolError("PaddleOCR returned unsupported or excessive text.")
        if (not isinstance(polygon, list) or len(polygon) != 4
                or any(not isinstance(point, list) or len(point) != 2
                       or any(type(value) not in (int, float) or not math.isfinite(value) for value in point)
                       or not -1 <= point[0] <= width + 1 or not -1 <= point[1] <= height + 1 for point in polygon)):
            raise core.PdfToolError("PaddleOCR returned an invalid word position.")
        if not text.strip():
            continue
        p0, _, p2, p3 = polygon
        area = (p2[0] - p3[0]) * (p0[1] - p3[1]) - (p2[1] - p3[1]) * (p0[0] - p3[0])
        if math.dist(p2, p3) < 0.01 or math.dist(p0, p3) < 0.01 or abs(area) < 0.01:
            raise core.PdfToolError("PaddleOCR returned an empty word position.")
        validated.append((text, p0, p2, p3))
    codes = {char: index + 1 for index, char in enumerate(sorted({char for text, *_ in validated for char in text}))}
    if len(codes) > 65534:
        raise core.PdfToolError("This OCR page contains too many distinct characters.")
    scale = 72 / dpi
    with pikepdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(max(3, width * scale), max(3, height * scale)))
        page.MediaBox = [0, 0, width * scale, height * scale]
        page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(OCR=_font(pdf, codes)))
        ops = []
        for text, p0, p2, p3 in validated:
            n = len(text)
            matrix = [(p2[0] - p3[0]) / n, -(p2[1] - p3[1]) / n,
                      p0[0] - p3[0], -(p0[1] - p3[1]), p3[0], height - p3[1]]
            ops += [core._op("BT"), core._op("Tr", 3), core._op("Tf", pikepdf.Name.OCR, 1),
                    ([Decimal(str(value * scale)) for value in matrix], pikepdf.Operator("Tm")),
                    core._op("Tj", pikepdf.String(b"".join(codes[char].to_bytes(2, "big") for char in text))), core._op("ET")]
        page.Contents = pdf.make_stream(pikepdf.unparse_content_stream(ops))
        return core._save(pdf, min_version="1.6")
