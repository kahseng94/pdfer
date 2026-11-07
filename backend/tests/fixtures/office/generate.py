"""Regenerate synthetic integration fixtures (requires python-docx, openpyxl, python-pptx and LibreOffice).

These libraries are needed only to regenerate the checked-in files, not to run pdfer or its tests.
Run with a Python environment containing them; PDFER_LIBREOFFICE may select soffice.
"""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from docx import Document
from docx.shared import Inches as WordInches
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from pptx import Presentation
from pptx.util import Inches, Pt

root = Path(__file__).resolve().parent
document = Document()
document.sections[0].header.paragraphs[0].text = "pdfer conversion test"
document.add_heading("Word conversion fixture", 0)
document.add_paragraph("A local conversion should preserve this text, the table and the page break.")
table = document.add_table(rows=1, cols=2)
table.style = "Light Shading Accent 1"
table.rows[0].cells[0].text = "Format"
table.rows[0].cells[1].text = "Result"
for label in ("Word", "Excel", "PowerPoint"):
    cells = table.add_row().cells
    cells[0].text, cells[1].text = label, "PDF"
document.sections[0].left_margin = WordInches(0.8)
document.add_page_break()
document.add_heading("Second page", level=1)
document.add_paragraph("The explicit page break must survive conversion.")
document.save(root / "word.docx")

book = Workbook()
sheet = book.active
sheet.title = "Conversion"
sheet.append(["Excel conversion fixture"])
sheet.merge_cells("A1:C1")
sheet["A1"].font = Font(size=18, bold=True)
sheet.append(["Item", "Quantity", "Amount"])
sheet.append(["Documents", 3, 12])
sheet.append(["Images", 2, 8])
sheet.append(["Total", "=SUM(B3:B4)", "=SUM(C3:C4)"])
for cell in sheet[2]:
    cell.fill = PatternFill("solid", fgColor="BBDDEE")
    cell.font = Font(bold=True)
sheet.column_dimensions["A"].width = 38
sheet.column_dimensions["B"].width = 16
sheet.column_dimensions["C"].width = 16
sheet.print_area = "A1:C5"
sheet.sheet_properties.pageSetUpPr.fitToPage = True
sheet.page_setup.orientation = "landscape"
sheet.page_setup.paperSize = sheet.PAPERSIZE_A4
sheet.page_setup.fitToWidth = 1
sheet.page_setup.fitToHeight = 1
book.save(root / "excel.xlsx")

deck = Presentation()
deck.slide_width, deck.slide_height = Inches(10), Inches(5.625)
for title, body in (("PowerPoint conversion fixture", "A slide becomes one PDF page."), ("Second slide", "Text and shapes should remain sharp.")):
    slide = deck.slides.add_slide(deck.slide_layouts[5])
    slide.shapes.title.text = title
    for paragraph in slide.shapes.title.text_frame.paragraphs:
        paragraph.font.size = Pt(28)
    slide.shapes.add_textbox(Inches(0.8), Inches(1.8), Inches(8), Inches(1)).text_frame.text = body
    slide.shapes.add_shape(1, Inches(0.8), Inches(3), Inches(3), Inches(0.8))
deck.save(root / "powerpoint.pptx")

executable = os.environ.get("PDFER_LIBREOFFICE") or shutil.which("soffice")
if not executable:
    raise SystemExit("Set PDFER_LIBREOFFICE to regenerate the legacy fixtures.")
with tempfile.TemporaryDirectory(prefix="pdfer-office-fixtures-") as temporary:
    for name, source, target in (("word", "docx", "doc:MS Word 97"), ("excel", "xlsx", "xls:MS Excel 97"), ("powerpoint", "pptx", "ppt:MS PowerPoint 97")):
        subprocess.run([executable, f"-env:UserInstallation={Path(temporary).as_uri()}", "--headless", "--convert-to", target,
                        "--outdir", str(root), str(root / f"{name}.{source}")], check=True, timeout=60)
        assert (root / f"{name}.{target.split(':')[0]}").is_file()
