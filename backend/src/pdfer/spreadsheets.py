"""Convert between Excel workbooks (.xlsx, .xlsm) and CSV files without Excel or LibreOffice.

Workbooks are read as values: each formula gives the result the spreadsheet
app saved with it. Formulas are never evaluated, and CSV text that looks like a
formula is written to Excel as text, never as a formula.
"""

import codecs
import csv
import datetime
import io
import math
import re
import zipfile
from collections import Counter
from collections.abc import Callable
from itertools import islice, zip_longest
from pathlib import Path
from xml.etree import ElementTree

import openpyxl
from openpyxl.cell import WriteOnlyCell
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.formula import ArrayFormula

from pdfer.core import PdfToolError
from pdfer.number_formats import display, general as cell_text

MAX_WORKBOOK_BYTES = 64 * 1024 * 1024
MAX_UNPACKED_BYTES = 512 * 1024 * 1024
MAX_CSV_BYTES = 64 * 1024 * 1024
MAX_CSV_FILES = 50
MAX_ROWS = 1_048_576
MAX_COLUMNS = 16_384
MAX_CELL_CHARS = 32_767
# Numbers longer than this lose digits in Excel, so they stay text (IDs, card numbers).
MAX_DIGITS = 15
# The viewer shows this much of a sheet; converting to CSV gets all of it.
MAX_VIEW_ROWS = 100_000
MAX_VIEW_CELLS = 2_000_000

DELIMITERS = {"comma": ",", "semicolon": ";", "tab": "\t"}
_DETECTED = {",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe"}
_OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
_ZIP_MAGIC = b"PK\x03\x04"
_SHEET_NAME_FORBIDDEN = re.compile(r"[\[\]:*?/\\]")
_FILE_NAME_FORBIDDEN = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_NUMBER = re.compile(r"[+-]?(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?")
_INTEGER = re.compile(r"[+-]?(?:0|[1-9]\d*)")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_DATETIME = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?")
_TIME = re.compile(r"\d{1,2}:\d{2}:\d{2}")
_MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


class Cancelled(Exception):
    """The browser stopped waiting, so the conversion was abandoned."""


def _never() -> bool:
    return False


# Excel to CSV ------------------------------------------------------------------

def _validate_workbook(data: bytes, filename: str) -> None:
    suffix = Path(filename).suffix.lower()
    if suffix == ".xls" or (data.startswith(_OLE_MAGIC) and suffix not in (".xlsx", ".xlsm")):
        raise PdfToolError("Old .xls workbooks can’t be read here. Open it in Excel or LibreOffice and save it as .xlsx first.")
    if suffix not in (".xlsx", ".xlsm"):
        raise PdfToolError("Choose an Excel workbook (.xlsx or .xlsm).")
    if not data:
        raise PdfToolError("This workbook is empty. Choose a file with content.")
    if len(data) > MAX_WORKBOOK_BYTES:
        raise PdfToolError("Workbooks must be 64 MB or smaller. Split it into smaller workbooks first.")
    if data.startswith(_OLE_MAGIC):
        raise PdfToolError("This workbook is password protected. Save an unprotected copy in Excel first.")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 10000 or sum(item.file_size for item in entries) > MAX_UNPACKED_BYTES:
                raise PdfToolError("This workbook expands to too much data. Split it into smaller workbooks first.")
            if any(item.flag_bits & 1 for item in entries):
                raise PdfToolError("This workbook is password protected. Save an unprotected copy in Excel first.")
            names = {item.filename for item in entries}
            if "[Content_Types].xml" not in names or "xl/workbook.xml" not in names:
                raise ValueError
    except PdfToolError:
        raise
    except (zipfile.BadZipFile, ValueError, OSError):
        raise PdfToolError("This is not a valid Excel workbook. Open it in Excel and save a new copy.") from None


def _open_workbook(data: bytes, filename: str):
    _validate_workbook(data, filename)
    try:
        return openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True, keep_links=False)
    except Exception:
        raise PdfToolError("This workbook could not be read. Open it in Excel and save a new copy.") from None


def _visible_sheet(workbook) -> int:
    """The worksheet Excel opens on, or the first visible one when that is a chart or hidden."""
    sheets = workbook.worksheets
    try:
        active = workbook.active
    except (IndexError, AttributeError):
        active = None
    if active in sheets and active.sheet_state == "visible":
        return sheets.index(active)
    return next((index for index, sheet in enumerate(sheets) if sheet.sheet_state == "visible"), 0)


def sheets(data: bytes, filename: str = "workbook.xlsx") -> dict:
    """The workbook's worksheets (charts excluded) and the one it opens on."""
    workbook = _open_workbook(data, filename)
    try:
        listed = [{"name": sheet.title, "hidden": sheet.sheet_state != "visible"} for sheet in workbook.worksheets]
        if not listed:
            raise PdfToolError("This workbook has no worksheets, only charts.")
        return {"sheets": listed, "active": _visible_sheet(workbook)}
    finally:
        workbook.close()


def _uncalculated(sheet) -> int:
    """Formula cells saved without a result, so the CSV can only leave them empty.

    openpyxl reads a missing result and an empty-text result alike, so this
    looks at the sheet's XML for formulas that have no value element at all.
    """
    try:
        source = sheet._get_source()
    except (AttributeError, KeyError, OSError):
        return 0
    count = 0
    container = None
    with source:
        for event, element in ElementTree.iterparse(source, events=("start", "end")):
            if event == "start":
                if element.tag == _MAIN + "sheetData":
                    container = element
                continue
            if element.tag == _MAIN + "c":
                if element.find(_MAIN + "f") is not None and element.find(_MAIN + "v") is None:
                    count += 1
            elif element.tag == _MAIN + "row" and container is not None:
                container.clear()
    return count


def _sheet_csv(sheet, delimiter: str, cancelled: Callable[[], bool]) -> tuple[str, int, int]:
    """One worksheet as CSV text with the same number of fields on every line, and its rows and columns."""
    # Some generators record a wrong used range; read every row that is actually there.
    sheet.reset_dimensions()
    out = io.StringIO()
    writer = csv.writer(out, delimiter=delimiter, lineterminator="\r\n")
    lines: list[tuple[str, int]] = []
    width = last = 0
    for index, row in enumerate(sheet.iter_rows(values_only=True)):
        if index % 500 == 0 and cancelled():
            raise Cancelled
        cells = [cell_text(value) for value in row]
        while cells and not cells[-1]:
            cells.pop()
        if cells:
            out.seek(0)
            out.truncate()
            writer.writerow(cells)
            lines.append((out.getvalue()[:-2], len(cells)))
            width = max(width, len(cells))
            last = len(lines)
        else:
            lines.append(("", 0))
    if not width:
        return "", 0, 0
    text = "".join(line + delimiter * (width - max(count, 1)) + "\r\n" for line, count in lines[:last])
    return text, last, width


def _csv_name(text: str) -> str:
    cleaned = _FILE_NAME_FORBIDDEN.sub("_", text).strip(" .")
    return cleaned or "sheet"


def to_csv(data: bytes, filename: str = "workbook.xlsx", sheet: str = "active", delimiter: str = "comma",
           bom: bool = True, cancelled: Callable[[], bool] = _never) -> tuple[list[tuple[str, bytes]], dict]:
    """Save one worksheet, or every worksheet with data, as CSV.

    `sheet` is "active", "all" or a 0-based index into the worksheets. Returns
    the files as (name, bytes) and a summary with each sheet's rows and columns
    and how many formulas had no saved result.
    """
    if delimiter not in DELIMITERS:
        raise PdfToolError("Choose comma, semicolon or tab as the separator.")
    separator = DELIMITERS[delimiter]
    stem = _csv_name(Path(filename).stem) if Path(filename).stem else "workbook"
    workbook = _open_workbook(data, filename)
    try:
        worksheets = workbook.worksheets
        if not worksheets:
            raise PdfToolError("This workbook has no worksheets, only charts.")
        if sheet == "all":
            chosen = list(worksheets)
        else:
            if sheet == "active":
                index = _visible_sheet(workbook)
            else:
                try:
                    index = int(sheet)
                except ValueError:
                    index = -1
                if not 0 <= index < len(worksheets):
                    raise PdfToolError("That sheet is not in this workbook. Choose the workbook again.")
            chosen = [worksheets[index]]
        files: list[tuple[str, bytes]] = []
        summary: dict = {"sheets": [], "uncalculated": 0}
        try:
            for worksheet in chosen:
                text, rows, columns = _sheet_csv(worksheet, separator, cancelled)
                if not rows:
                    continue
                summary["uncalculated"] += _uncalculated(worksheet)
                summary["sheets"].append({"name": worksheet.title, "rows": rows, "columns": columns})
                payload = ("﻿" if bom else "") + text
                # In a ZIP of every sheet the sheet name is enough; a lone CSV keeps the workbook's name.
                if sheet == "all":
                    name = f"{_csv_name(worksheet.title)}.csv"
                elif len(worksheets) == 1:
                    name = f"{stem}.csv"
                else:
                    name = f"{stem}_{_csv_name(worksheet.title)}.csv"
                files.append((name, payload.encode("utf-8")))
        except (PdfToolError, Cancelled):
            raise
        except Exception:
            raise PdfToolError("This workbook could not be read. Open it in Excel and save a new copy.") from None
        if not files:
            if sheet == "all":
                raise PdfToolError("Every worksheet in this workbook is empty.")
            raise PdfToolError(f"The sheet “{chosen[0].title}” is empty. Choose another sheet.")
        return files, summary
    finally:
        workbook.close()


# CSV to Excel ------------------------------------------------------------------

def _decode(data: bytes, name: str) -> tuple[str, str]:
    if data.startswith((_ZIP_MAGIC, _OLE_MAGIC)):
        raise PdfToolError(f"{name} is a workbook or other binary file, not CSV text. Use Excel to CSV for workbooks.")
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        try:
            return data.decode("utf-16"), "UTF-16"
        except UnicodeDecodeError:
            raise PdfToolError(f"{name} is not valid UTF-16 text. Save it again as CSV UTF-8.") from None
    if data.startswith(codecs.BOM_UTF8):
        data = data[len(codecs.BOM_UTF8):]
    try:
        text, encoding = data.decode("utf-8"), "UTF-8"
    except UnicodeDecodeError:
        try:
            text, encoding = data.decode("cp1252"), "Windows-1252"
        except UnicodeDecodeError:
            text, encoding = data.decode("latin-1"), "ISO-8859-1"
    if "\x00" in text:
        raise PdfToolError(f"{name} is not a CSV text file.")
    return text, encoding


def _detect_delimiter(text: str, suffix: str) -> str:
    """The separator that splits the first lines into the same number of fields most consistently."""
    sample = text[:65536]
    cut = len(text) > len(sample)
    best, best_score = None, (0.0, 0)
    for candidate in (",", ";", "\t", "|"):
        try:
            rows = [row for row in islice(csv.reader(io.StringIO(sample, newline=""), delimiter=candidate), 100) if row]
        except csv.Error:
            continue
        if cut and len(rows) > 1:
            rows.pop()
        counts = [len(row) for row in rows]
        if not counts:
            continue
        common, times = Counter(counts).most_common(1)[0]
        if common < 2:
            continue
        score = (times / len(counts), common)
        if score > best_score:
            best, best_score = candidate, score
    return best or ("\t" if suffix == ".tsv" else ",")


def _significant_digits(text: str) -> int:
    mantissa = re.split("[eE]", text.lstrip("+-"))[0]
    digits = mantissa.replace(".", "").lstrip("0")
    if "." in mantissa:
        digits = digits.rstrip("0")
    return len(digits)


def typed_value(text: str):
    """What Excel would store for a CSV field, keeping anything that would lose information as text.

    Plain numbers become numbers unless they have leading zeros or more than
    15 significant digits. ISO dates (2026-11-07), date-times and h:mm:ss times
    become dates and times; TRUE and FALSE become logical values.
    """
    if not text:
        return None
    # The pattern has no leading zeros (007 stays text), but 0.5 and .5 are numbers.
    if _NUMBER.fullmatch(text):
        if _significant_digits(text) > MAX_DIGITS:
            return text
        if _INTEGER.fullmatch(text):
            return int(text)
        number = float(text)
        return number if math.isfinite(number) else text
    upper = text.upper()
    if upper in ("TRUE", "FALSE"):
        return upper == "TRUE"
    try:
        if _DATE.fullmatch(text):
            value = datetime.date.fromisoformat(text)
            return value if value.year >= 1900 else text
        if _DATETIME.fullmatch(text):
            value = datetime.datetime.fromisoformat(text)
            return value if value.year >= 1900 else text
        if _TIME.fullmatch(text):
            return datetime.time.fromisoformat(text.zfill(8))
    except ValueError:
        return text
    return text


def _read_csv(data: bytes, name: str, delimiter: str) -> tuple[str, str, str]:
    """The file's text, its separator and the encoding it was read with."""
    text, encoding = _decode(data, name)
    first_end = text.find("\n")
    hint = re.fullmatch(r"sep=(.)\r?", text if first_end < 0 else text[:first_end], re.IGNORECASE)
    if hint:
        # Excel's own hint line names the separator; it is not part of the data.
        return ("" if first_end < 0 else text[first_end + 1:]), hint.group(1), encoding
    if delimiter == "auto":
        return text, _detect_delimiter(text, Path(name).suffix.lower()), encoding
    return text, DELIMITERS[delimiter], encoding


def _sheet_name(stem: str, used: set[str], number: int) -> str:
    name = _SHEET_NAME_FORBIDDEN.sub("_", stem).strip().strip("'")[:31].strip() or f"Sheet{number}"
    if name.casefold() == "history":
        # Excel reserves this name for its change-tracking sheet.
        name = f"{name}_"
    candidate, copy = name, 1
    while candidate.casefold() in used:
        copy += 1
        suffix = f" ({copy})"
        candidate = name[:31 - len(suffix)] + suffix
    used.add(candidate.casefold())
    return candidate


def _rows(text: str, separator: str, name: str):
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=separator)
    try:
        yield from reader
    except csv.Error as error:
        detail = "a cell is longer than Excel allows (32,767 characters)" if "field larger" in str(error) else str(error)
        raise PdfToolError(f"Line {reader.line_num} of {name} could not be read: {detail}.") from None


def to_xlsx(files: list[tuple[str, bytes]], delimiter: str = "auto", detect_types: bool = True,
            header: bool = True, cancelled: Callable[[], bool] = _never) -> tuple[bytes, dict]:
    """Put each CSV file on its own worksheet of a new workbook, in the order given.

    `delimiter` is "auto" or one of DELIMITERS. With `detect_types`, fields
    become numbers, dates and logical values where that loses nothing; without
    it every field stays text. `header` makes the first row bold, keeps it in
    view while scrolling and adds filter buttons.
    """
    if not files:
        raise PdfToolError("Choose at least one CSV file.")
    if len(files) > MAX_CSV_FILES:
        raise PdfToolError(f"Choose at most {MAX_CSV_FILES} CSV files at a time.")
    if delimiter != "auto" and delimiter not in DELIMITERS:
        raise PdfToolError("Choose automatic, comma, semicolon or tab as the separator.")
    if sum(len(data) for _, data in files) > MAX_CSV_BYTES:
        raise PdfToolError("CSV files must be 64 MB or smaller in total. Convert fewer files at a time.")
    workbook = openpyxl.Workbook(write_only=True)
    bold = Font(bold=True)
    used: set[str] = set()
    summary: dict = {"sheets": [], "removed": 0}
    for number, (filename, data) in enumerate(files, start=1):
        name = Path(filename).name or f"File {number}"
        if not data.strip():
            raise PdfToolError(f"{name} is empty. Choose a CSV file with content.")
        text, separator, encoding = _read_csv(data, name, delimiter)
        sheet = workbook.create_sheet(_sheet_name(Path(name).stem, used, number))
        # Column widths and frozen panes go before the first row in a streamed sheet.
        widths: dict[int, int] = {}
        for row in islice(_rows(text, separator, name), 1000):
            for column, field in enumerate(row[:MAX_COLUMNS]):
                widths[column] = max(widths.get(column, 0), min(len(field), 60))
        for column, width in widths.items():
            sheet.column_dimensions[get_column_letter(column + 1)].width = max(8, width + 2)
        if header:
            sheet.freeze_panes = "A2"
        rows = columns = 0
        for index, row in enumerate(_rows(text, separator, name)):
            if index % 500 == 0 and cancelled():
                raise Cancelled
            if rows >= MAX_ROWS:
                raise PdfToolError(f"{name} has more rows than an Excel sheet can hold ({MAX_ROWS:,}). Split it first.")
            if len(row) > MAX_COLUMNS:
                raise PdfToolError(f"Line {index + 1} of {name} has more columns than an Excel sheet can hold ({MAX_COLUMNS:,}).")
            cells = []
            for field in row:
                cleaned = ILLEGAL_CHARACTERS_RE.sub("", field)
                if len(cleaned) != len(field):
                    summary["removed"] += len(field) - len(cleaned)
                if len(cleaned) > MAX_CELL_CHARS:
                    raise PdfToolError(f"Line {index + 1} of {name} has a cell longer than Excel allows (32,767 characters).")
                value = typed_value(cleaned) if detect_types and not (header and index == 0) else (cleaned or None)
                cell = WriteOnlyCell(sheet, value=value)
                if isinstance(value, str):
                    # Text that starts with "=" stays text; it never becomes a formula.
                    cell.data_type = "s"
                if header and index == 0:
                    cell.font = bold
                cells.append(cell)
            sheet.append(cells)
            rows += 1
            columns = max(columns, len(row))
        if not rows:
            raise PdfToolError(f"{name} has no rows. Choose a CSV file with content.")
        if header and columns:
            sheet.auto_filter.ref = f"A1:{get_column_letter(columns)}{rows}"
        summary["sheets"].append({"name": sheet.title, "source": name, "rows": rows, "columns": columns,
                                  "delimiter": _DETECTED.get(separator, "other"), "encoding": encoding})
    out = io.BytesIO()
    workbook.save(out)
    return out.getvalue(), summary


# Viewer ------------------------------------------------------------------------

def view(data: bytes, filename: str = "file", sheet: int | None = None, delimiter: str = "auto",
         cancelled: Callable[[], bool] = _never) -> dict:
    """One sheet of a workbook, or a CSV file, as a grid of cells for display.

    Each row lists its cells up to the last one with content. A cell is null,
    a string for text, or [shown text, kind] for a value Excel aligns
    differently: "n" numbers and dates (shown in the cell's number format),
    "b" logical values, "e" errors. `formulas` and `values` list [row, column,
    text] for formulas and for values whose stored form differs from what is
    shown. At most MAX_VIEW_ROWS rows and about MAX_VIEW_CELLS cells are sent;
    `truncated` says when the sheet has more.
    """
    if delimiter != "auto" and delimiter not in DELIMITERS:
        raise PdfToolError("Choose automatic, comma, semicolon or tab as the separator.")
    name = Path(filename).name or "file"
    if Path(name).suffix.lower() in (".csv", ".tsv"):
        return _view_csv(data, name, delimiter, cancelled)
    return _view_workbook(data, name, sheet, cancelled)


def _grid(rows: list[list], width: int, truncated: bool) -> dict:
    last = len(rows)
    while last and not rows[last - 1]:
        last -= 1
    del rows[last:]
    return {"rows": rows, "columns": width, "truncated": truncated}


def _view_csv(data: bytes, name: str, delimiter: str, cancelled: Callable[[], bool]) -> dict:
    if len(data) > MAX_CSV_BYTES:
        raise PdfToolError("CSV files must be 64 MB or smaller.")
    if not data.strip():
        raise PdfToolError(f"{name} is empty. Choose a CSV file with content.")
    text, separator, encoding = _read_csv(data, name, delimiter)
    rows: list[list] = []
    width = cells = 0
    truncated = False
    for index, row in enumerate(_rows(text, separator, name)):
        if index % 500 == 0 and cancelled():
            raise Cancelled
        if len(rows) >= MAX_VIEW_ROWS or cells >= MAX_VIEW_CELLS:
            truncated = True
            break
        out: list = []
        for field in row:
            typed = typed_value(field) if field else None
            if typed is None:
                out.append(None)
            elif isinstance(typed, bool):
                out.append([field, "b"])
            elif isinstance(typed, str):
                out.append(field)
            else:
                out.append([field, "n"])
        while out and out[-1] is None:
            out.pop()
        rows.append(out)
        width = max(width, len(out))
        cells += len(out)
    grid = _grid(rows, width, truncated)
    return {"sheets": [{"name": Path(name).stem or name, "hidden": False}], "sheet": 0, **grid,
            "formulas": [], "values": [], "csv": {"delimiter": _DETECTED.get(separator, "other"), "encoding": encoding}}


def _view_cell(cell) -> tuple[object, str | None]:
    """A workbook cell for the grid, and its stored value as text when that differs from what is shown."""
    value = getattr(cell, "value", None)
    if value is None:
        return None, None
    if isinstance(value, str):
        return ([value, "e"] if getattr(cell, "data_type", None) == "e" else value), None
    if isinstance(value, bool):
        return ["TRUE" if value else "FALSE", "b"], None
    shown = display(value, getattr(cell, "number_format", None))
    stored = cell_text(value)
    return [shown, "n"], (stored if stored != shown else None)


def _view_workbook(data: bytes, name: str, sheet: int | None, cancelled: Callable[[], bool]) -> dict:
    values = _open_workbook(data, name)
    try:
        formulas_book = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=False, keep_links=False)
    except Exception:
        values.close()
        raise PdfToolError("This workbook could not be read. Open it in Excel and save a new copy.") from None
    try:
        worksheets = values.worksheets
        if not worksheets:
            raise PdfToolError("This workbook has no worksheets, only charts.")
        index = _visible_sheet(values) if sheet is None else sheet
        if not 0 <= index < len(worksheets):
            raise PdfToolError("That sheet is not in this workbook. Choose the workbook again.")
        shown, written = worksheets[index], formulas_book.worksheets[index]
        shown.reset_dimensions()
        written.reset_dimensions()
        rows: list[list] = []
        formulas: list[list] = []
        stored: list[list] = []
        width = cells = 0
        truncated = False
        try:
            pairs = zip_longest(shown.iter_rows(), written.iter_rows(values_only=True), fillvalue=())
            for number, (row, row_formulas) in enumerate(pairs):
                if number % 500 == 0 and cancelled():
                    raise Cancelled
                full = len(rows) >= MAX_VIEW_ROWS or cells >= MAX_VIEW_CELLS
                out: list = []
                for column, cell in enumerate(row):
                    item, raw = _view_cell(cell)
                    formula = row_formulas[column] if column < len(row_formulas) else None
                    if isinstance(formula, ArrayFormula):
                        formula = formula.text
                    if not (isinstance(formula, str) and formula.startswith("=") and item != formula):
                        formula = None
                    if full and (item is not None or formula):
                        truncated = True
                        break
                    out.append(item)
                    if formula:
                        formulas.append([number, column, formula])
                    if raw is not None:
                        stored.append([number, column, raw])
                    if item is not None or formula:
                        width = max(width, column + 1)
                if truncated:
                    break
                if full:
                    continue
                while out and out[-1] is None:
                    out.pop()
                rows.append(out)
                cells += len(out)
        except (PdfToolError, Cancelled):
            raise
        except Exception:
            raise PdfToolError("This workbook could not be read. Open it in Excel and save a new copy.") from None
        grid = _grid(rows, width, truncated)
        sheets = [{"name": item.title, "hidden": item.sheet_state != "visible"} for item in worksheets]
        return {"sheets": sheets, "sheet": index, **grid, "formulas": formulas, "values": stored, "csv": None}
    finally:
        values.close()
        formulas_book.close()
