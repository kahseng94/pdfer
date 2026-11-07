import datetime
import json
import re
import zipfile
from io import BytesIO

import openpyxl
import pytest
from openpyxl.chart import BarChart, Reference
from openpyxl.worksheet.formula import ArrayFormula
from fastapi.testclient import TestClient

from pdfer import spreadsheets
from pdfer.api import app
from pdfer.core import PdfToolError


def workbook(*sheets, active=0, hidden=(), chart=False) -> bytes:
    """An .xlsx with one worksheet per (title, rows) pair."""
    book = openpyxl.Workbook()
    book.remove(book.active)
    for title, rows in sheets:
        sheet = book.create_sheet(title)
        for row in rows:
            sheet.append(row)
        if title in hidden:
            sheet.sheet_state = "hidden"
    if chart:
        chart_data = Reference(book.worksheets[0], min_col=1, min_row=1)
        bars = BarChart()
        bars.add_data(chart_data)
        book.create_chartsheet("Chart").add_chart(bars)
    book.active = active
    out = BytesIO()
    book.save(out)
    return out.getvalue()


def read_xlsx(data: bytes) -> dict[str, list[tuple]]:
    book = openpyxl.load_workbook(BytesIO(data))
    return {sheet.title: list(sheet.iter_rows(values_only=True)) for sheet in book.worksheets}


def csv_text(entry: tuple[str, bytes]) -> str:
    return entry[1].decode("utf-8-sig")


def rewrite(data: bytes, part: str, change) -> bytes:
    """Copy a workbook with one of its XML parts edited."""
    out = BytesIO()
    with zipfile.ZipFile(BytesIO(data)) as source, zipfile.ZipFile(out, "w") as target:
        for item in source.infolist():
            content = source.read(item)
            target.writestr(item, change(content.decode()).encode() if item.filename == part else content)
    return out.getvalue()


# Excel to CSV ------------------------------------------------------------------

def test_values_are_written_as_excel_shows_them_in_general_format():
    data = workbook(("Data", [
        ["name", "amount", "when", "at", "time", "ok", "ratio"],
        ["Ada, Countess", 1.0, datetime.date(2026, 1, 2), datetime.datetime(2026, 1, 2, 10, 30), datetime.time(9, 5), True, 0.1 + 0.2],
        ['Quote "me"', 12345678901, None, datetime.datetime(2026, 1, 2, 10, 30, 0, 250000), None, False, 1 / 3],
    ]))
    files, summary = spreadsheets.to_csv(data, "report.xlsx")
    assert [name for name, _ in files] == ["report.csv"]
    assert files[0][1].startswith(b"\xef\xbb\xbf")
    assert csv_text(files[0]).split("\r\n") == [
        "name,amount,when,at,time,ok,ratio",
        '"Ada, Countess",1,2026-01-02,2026-01-02 10:30:00,09:05:00,TRUE,0.3',
        '"Quote ""me""",12345678901,,2026-01-02 10:30:00.250,,FALSE,0.333333333333333',
        "",
    ]
    assert summary == {"sheets": [{"name": "Data", "rows": 3, "columns": 7}], "uncalculated": 0}


def test_rows_are_padded_to_the_widest_row_and_trailing_blanks_dropped():
    data = workbook(("Data", [[None, "b"], [], ["a", None, None, "d"], [None], [None, None]]))
    files, summary = spreadsheets.to_csv(data, "x.xlsx", delimiter="semicolon", bom=False)
    assert files[0][1].decode() == ";b;;\r\n;;;\r\na;;;d\r\n"
    assert summary["sheets"][0] == {"name": "Data", "rows": 3, "columns": 4}


def test_tab_separated_output_and_a_wrong_recorded_used_range_is_ignored():
    data = workbook(("Data", [["a", "b"], ["c", "d"], ["e", "f"]]))
    data = rewrite(data, "xl/worksheets/sheet1.xml", lambda xml: re.sub(r'<dimension ref="[^"]+"', '<dimension ref="A1"', xml))
    files, _ = spreadsheets.to_csv(data, "x.xlsx", delimiter="tab", bom=False)
    assert files[0][1].decode() == "a\tb\r\nc\td\r\ne\tf\r\n"


def test_sheet_choice_defaults_to_the_visible_sheet_excel_opens_on():
    data = workbook(("One", [[1]]), ("Two", [[2]]), ("Secret", [[3]]), active=1, hidden=("Secret",))
    assert spreadsheets.sheets(data, "book.xlsx") == {
        "sheets": [{"name": "One", "hidden": False}, {"name": "Two", "hidden": False}, {"name": "Secret", "hidden": True}],
        "active": 1,
    }
    files, _ = spreadsheets.to_csv(data, "book.xlsx")
    assert files == [("book_Two.csv", "\ufeff2\r\n".encode())]
    files, _ = spreadsheets.to_csv(data, "book.xlsx", sheet="2")
    assert files[0][0] == "book_Secret.csv"
    hidden_active = workbook(("Shown", [[1]]), ("Hidden", [[2]]), active=1, hidden=("Hidden",))
    assert spreadsheets.sheets(hidden_active)["active"] == 0


def test_chart_sheets_are_not_listed():
    data = workbook(("Data", [[1]]), chart=True, active=1)
    assert spreadsheets.sheets(data) == {"sheets": [{"name": "Data", "hidden": False}], "active": 0}


def test_all_sheets_skips_empty_ones_and_names_files_after_sheets():
    data = workbook(("Q1|Q2", [["a"]]), ("Empty", []), ("Totals", [["b"]]))
    files, summary = spreadsheets.to_csv(data, "book.xlsx", sheet="all")
    assert [name for name, _ in files] == ["Q1_Q2.csv", "Totals.csv"]
    assert [sheet["name"] for sheet in summary["sheets"]] == ["Q1|Q2", "Totals"]


@pytest.mark.parametrize("sheet,message", [("1", "“Empty” is empty"), ("all", "Every worksheet"), ("7", "not in this workbook"), ("x", "not in this workbook")])
def test_empty_or_missing_sheets_are_reported(sheet, message):
    data = workbook(("Data", []), ("Empty", []))
    with pytest.raises(PdfToolError, match=message):
        spreadsheets.to_csv(data, "book.xlsx", sheet=sheet)


def test_formulas_without_a_saved_result_are_counted_but_empty_text_results_are_not():
    data = workbook(("Data", [["a", "b", "c"], [1, 2, None]]))
    def add_formulas(xml):
        cells = ('<c r="C2"><f>A2+B2</f></c><c r="D2" t="str"><f>IF(A2=0,"",1)</f><v></v></c>'
                 '<c r="E2"><f>A2*2</f><v>2</v></c>')
        return xml.replace('<c r="B2" t="n"><v>2</v></c>', '<c r="B2" t="n"><v>2</v></c>' + cells)
    data = rewrite(data, "xl/worksheets/sheet1.xml", add_formulas)
    files, summary = spreadsheets.to_csv(data, "x.xlsx", bom=False)
    assert files[0][1].decode() == "a,b,c,,\r\n1,2,,,2\r\n"
    assert summary["uncalculated"] == 1


@pytest.mark.parametrize("name,data,message", [
    ("old.xls", spreadsheets._OLE_MAGIC + b"x", "save it as .xlsx"),
    ("locked.xlsx", spreadsheets._OLE_MAGIC + b"x", "password protected"),
    ("book.ods", b"PK", "Choose an Excel workbook"),
    ("book.xlsx", b"", "empty"),
    ("book.xlsx", b"not a zip", "not a valid Excel workbook"),
])
def test_unreadable_workbooks_explain_what_to_do(name, data, message):
    with pytest.raises(PdfToolError, match=message):
        spreadsheets.sheets(data, name)


def test_workbook_that_is_a_zip_without_a_workbook_part_is_rejected():
    out = BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
    with pytest.raises(PdfToolError, match="not a valid Excel workbook"):
        spreadsheets.to_csv(out.getvalue(), "book.xlsx")


def test_csv_export_stops_when_cancelled():
    with pytest.raises(spreadsheets.Cancelled):
        spreadsheets.to_csv(workbook(("Data", [[1]])), "x.xlsx", cancelled=lambda: True)


# CSV to Excel ------------------------------------------------------------------

def test_fields_become_numbers_dates_and_logicals_only_when_nothing_is_lost():
    text = ("id,amount,date,at,time,flag,zip,card,formula,note\r\n"
            "1,1.50,2026-11-07,2026-11-07T08:15:30,7:05:00,true,007,4111111111111111,=HYPERLINK(\"x\"),1e999\r\n"
            "-2,.5,1899-12-31,2026-02-30,25:00:00,FALSE,0.25,123456789012345,@cmd,+3\r\n")
    data, summary = spreadsheets.to_xlsx([("ledger.csv", text.encode())])
    rows = read_xlsx(data)["ledger"]
    assert rows[0] == ("id", "amount", "date", "at", "time", "flag", "zip", "card", "formula", "note")
    assert rows[1] == (1, 1.5, datetime.datetime(2026, 11, 7), datetime.datetime(2026, 11, 7, 8, 15, 30), datetime.time(7, 5),
                       True, "007", "4111111111111111", '=HYPERLINK("x")', "1e999")
    assert rows[2] == (-2, 0.5, "1899-12-31", "2026-02-30", "25:00:00", False, 0.25, 123456789012345, "@cmd", 3)
    with zipfile.ZipFile(BytesIO(data)) as archive:
        assert "<f>" not in archive.read("xl/worksheets/sheet1.xml").decode()
    assert summary == {"sheets": [{"name": "ledger", "source": "ledger.csv", "rows": 3, "columns": 10,
                                   "delimiter": "comma", "encoding": "UTF-8"}], "removed": 0}


def test_header_row_is_bold_frozen_and_filtered_and_stays_text():
    data, _ = spreadsheets.to_xlsx([("t.csv", b"2024,2025\n1,2\n3,4\n")])
    sheet = openpyxl.load_workbook(BytesIO(data)).active
    assert [cell.value for cell in sheet[1]] == ["2024", "2025"]
    assert sheet["A1"].font.b and not sheet["A2"].font.b
    assert sheet.freeze_panes == "A2"
    assert sheet.auto_filter.ref == "A1:B3"


def test_without_header_or_types_every_field_is_plain_text():
    data, _ = spreadsheets.to_xlsx([("t.csv", b"1,2026-01-02,TRUE\n")], detect_types=False, header=False)
    sheet = openpyxl.load_workbook(BytesIO(data)).active
    assert list(sheet.iter_rows(values_only=True)) == [("1", "2026-01-02", "TRUE")]
    assert sheet.freeze_panes is None and not sheet.auto_filter.ref and not sheet["A1"].font.b


@pytest.mark.parametrize("text,delimiter,expected", [
    ("a;b;c\n1,5;2;3\n", "semicolon", [("a", "b", "c"), ("1,5", 2, 3)]),
    ("a\tb\n1\t2\n", "tab", [("a", "b"), (1, 2)]),
    ("a|b\n1|2\n", "pipe", [("a", "b"), (1, 2)]),
    ('sep=;\na;"b,c"\n1;2\n', "semicolon", [("a", "b,c"), (1, 2)]),
    ("only\none\n", "comma", [("only",), ("one",)]),
])
def test_separator_is_detected(text, delimiter, expected):
    data, summary = spreadsheets.to_xlsx([("t.csv", text.encode())])
    assert summary["sheets"][0]["delimiter"] == delimiter
    assert read_xlsx(data)["t"] == expected


def test_chosen_separator_overrides_detection():
    data, summary = spreadsheets.to_xlsx([("t.csv", b"a;b,c\n")], delimiter="comma", header=False)
    assert read_xlsx(data)["t"] == [("a;b", "c")]
    assert summary["sheets"][0]["delimiter"] == "comma"


@pytest.mark.parametrize("raw,encoding", [
    ("café,naïve\n".encode("utf-8-sig"), "UTF-8"),
    ("café,naïve\n".encode("cp1252"), "Windows-1252"),
    ("café\tnaïve\n".encode("utf-16"), "UTF-16"),
])
def test_text_encodings_are_detected(raw, encoding):
    data, summary = spreadsheets.to_xlsx([("t.csv", raw)])
    assert read_xlsx(data)["t"] == [("café", "naïve")]
    assert summary["sheets"][0]["encoding"] == encoding


def test_each_file_gets_its_own_uniquely_named_sheet_in_order():
    files = [("b/History.csv", b"1\n"), ("Q1:Q2*.csv", b"2\n"), ("q1_q2_.csv", b"3\n"), ("x" * 40 + ".csv", b"4\n"), ("x" * 40 + ".tsv", b"5\n")]
    data, summary = spreadsheets.to_xlsx(files)
    assert list(read_xlsx(data)) == ["History_", "Q1_Q2_", "q1_q2_ (2)", "x" * 31, "x" * 27 + " (2)"]
    assert [sheet["source"] for sheet in summary["sheets"]] == ["History.csv", "Q1:Q2*.csv", "q1_q2_.csv", "x" * 40 + ".csv", "x" * 40 + ".tsv"]


def test_control_characters_excel_cannot_store_are_removed_and_counted():
    data, summary = spreadsheets.to_xlsx([("t.csv", b"a\x01b,c\x1f\n")], header=False)
    assert read_xlsx(data)["t"] == [("ab", "c")]
    assert summary["removed"] == 2


@pytest.mark.parametrize("files,message", [
    ([("book.csv", b"PK\x03\x04rest")], "not CSV text"),
    ([("e.csv", b" \r\n")], "e.csv is empty"),
    ([("n.csv", b"a\x00b\n")], "not a CSV text file"),
    ([("w.csv", ",".join(["1"] * 16385).encode())], "more columns"),
    ([("l.csv", b"a," + b"x" * 32768)], "longer than Excel allows"),
    ([("q.csv", b"a\n" + b"x" * 140000)], "longer than Excel allows"),
    ([], "at least one"),
    ([("a.csv", b"1")] * 51, "at most 50"),
])
def test_unusable_csv_files_are_rejected(files, message):
    with pytest.raises(PdfToolError, match=message):
        spreadsheets.to_xlsx(files)


def test_workbook_export_stops_when_cancelled():
    with pytest.raises(spreadsheets.Cancelled):
        spreadsheets.to_xlsx([("t.csv", b"1\n")], cancelled=lambda: True)


def test_csv_round_trips_through_a_workbook():
    text = "name,amount,when,code\r\nAda,1.5,2026-01-02,007\r\nBob,-3,2026-01-02 10:30:00,=1+1\r\n"
    workbook_bytes, _ = spreadsheets.to_xlsx([("ledger.csv", text.encode())])
    files, _ = spreadsheets.to_csv(workbook_bytes, "ledger.xlsx", bom=False)
    assert files[0][1].decode() == text


# HTTP --------------------------------------------------------------------------

@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_api_lists_sheets_and_converts_one_or_all(client):
    data = workbook(("One", [["a", 1]]), ("Two", [["b", 2]]))
    upload = {"file": ("C:\\Users\\me\\book.xlsx", data)}
    listed = client.post("/api/spreadsheets/sheets", files=upload)
    assert listed.json() == {"sheets": [{"name": "One", "hidden": False}, {"name": "Two", "hidden": False}], "active": 0}

    one = client.post("/api/spreadsheets/csv", files=upload, data={"sheet": "1", "delimiter": "semicolon", "bom": "false"})
    assert one.status_code == 200
    assert one.headers["content-type"].startswith("text/csv")
    assert "book_Two.csv" in one.headers["content-disposition"]
    assert one.content == b"b;2\r\n"
    assert json.loads(one.headers["x-spreadsheet-summary"]) == {"sheets": [{"name": "Two", "rows": 1, "columns": 2}], "uncalculated": 0}

    both = client.post("/api/spreadsheets/csv", files=upload, data={"sheet": "all"})
    assert both.headers["content-type"] == "application/zip"
    assert "book_sheets.zip" in both.headers["content-disposition"]
    with zipfile.ZipFile(BytesIO(both.content)) as archive:
        assert archive.namelist() == ["One.csv", "Two.csv"]


def test_api_builds_a_workbook_from_several_csv_files(client):
    files = [("files", ("sales.csv", b"a,b\n1,2\n", "text/csv")), ("files", ("costs.csv", "x;y\n3;4\n".encode("cp1252"), "text/csv"))]
    response = client.post("/api/spreadsheets/xlsx", files=files, data={"header": "false"})
    assert response.status_code == 200
    assert "combined.xlsx" in response.headers["content-disposition"]
    assert read_xlsx(response.content) == {"sales": [("a", "b"), (1, 2)], "costs": [("x", "y"), (3, 4)]}
    summary = json.loads(response.headers["x-spreadsheet-summary"])
    assert [(sheet["name"], sheet["delimiter"]) for sheet in summary["sheets"]] == [("sales", "comma"), ("costs", "semicolon")]

    single = client.post("/api/spreadsheets/xlsx", files=files[:1])
    assert "sales.xlsx" in single.headers["content-disposition"]


def test_api_reports_conversion_problems(client):
    response = client.post("/api/spreadsheets/xlsx", files=[("files", ("book.csv", b"PK\x03\x04", "text/csv"))])
    assert response.status_code == 400
    assert "Use Excel to CSV" in response.json()["detail"]
    response = client.post("/api/spreadsheets/csv", files={"file": ("old.xls", spreadsheets._OLE_MAGIC)})
    assert response.status_code == 400
    assert ".xlsx" in response.json()["detail"]


# Viewer ------------------------------------------------------------------------

def test_view_shows_a_sheet_as_excel_formats_it_with_formulas_and_stored_values():
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.title = "Money"
    sheet.append(["Item", "Price", "Share", "When", "Total", "Paid"])
    sheet.append(["Tea", 3.5, 0.25, datetime.date(2026, 1, 2), "=B2*2", True])
    sheet["B2"].number_format = '"$"#,##0.00'
    sheet["C2"].number_format = "0%"
    sheet["D2"].number_format = "d mmm yyyy"
    sheet["A3"] = "=1+1 is text"
    sheet["A3"].data_type = "s"
    sheet["G3"] = ArrayFormula("G3:G3", "=SUM(B2:C2)")
    sheet["A4"] = "#DIV/0!"
    sheet["A4"].data_type = "e"
    out = BytesIO()
    book.save(out)
    data = rewrite(out.getvalue(), "xl/worksheets/sheet1.xml", lambda xml: xml.replace("<f>B2*2</f>", "<f>B2*2</f><v>7</v>"))

    view = spreadsheets.view(data, "money.xlsx")
    assert view["sheets"] == [{"name": "Money", "hidden": False}]
    assert view["rows"] == [
        ["Item", "Price", "Share", "When", "Total", "Paid"],
        ["Tea", ["$3.50", "n"], ["25%", "n"], ["2 Jan 2026", "n"], ["7", "n"], ["TRUE", "b"]],
        ["=1+1 is text"],
        [["#DIV/0!", "e"]],
    ]
    assert view["columns"] == 7
    assert view["formulas"] == [[1, 4, "=B2*2"], [2, 6, "=SUM(B2:C2)"]]
    assert view["values"] == [[1, 1, "3.5"], [1, 2, "0.25"], [1, 3, "2026-01-02"]]
    assert view["truncated"] is False and view["csv"] is None


def test_view_opens_on_the_workbook_sheet_and_lists_hidden_ones():
    data = workbook(("One", [[1]]), ("Two", [[2]]), ("Secret", [["s"]]), active=1, hidden=("Secret",))
    first = spreadsheets.view(data, "book.xlsx")
    assert first["sheet"] == 1 and first["rows"] == [[["2", "n"]]]
    assert first["sheets"][2] == {"name": "Secret", "hidden": True}
    assert spreadsheets.view(data, "book.xlsx", sheet=2)["rows"] == [["s"]]
    with pytest.raises(PdfToolError, match="not in this workbook"):
        spreadsheets.view(data, "book.xlsx", sheet=3)
    assert spreadsheets.view(workbook(("Empty", [])), "e.xlsx")["rows"] == []


def test_view_stops_at_the_row_limit_and_says_so(monkeypatch):
    monkeypatch.setattr(spreadsheets, "MAX_VIEW_ROWS", 2)
    data = workbook(("Data", [["a"], ["b"], ["c"]]))
    view = spreadsheets.view(data, "x.xlsx")
    assert view["rows"] == [["a"], ["b"]] and view["truncated"] is True
    exact = spreadsheets.view(workbook(("Data", [["a"], ["b"], [None]])), "x.xlsx")
    assert exact["truncated"] is False
    csv_view = spreadsheets.view(b"1\n2\n3\n", "x.csv")
    assert csv_view["rows"] == [[["1", "n"]], [["2", "n"]]] and csv_view["truncated"] is True


def test_view_reads_csv_files_with_their_detected_or_chosen_separator():
    view = spreadsheets.view("name;amount;code;ok\nCafé;1,5;007;true\n;2;;\n\n".encode("cp1252"), "list.csv")
    assert view["sheets"] == [{"name": "list", "hidden": False}]
    assert view["rows"] == [["name", "amount", "code", "ok"], ["Café", "1,5", "007", ["true", "b"]], [None, ["2", "n"]]]
    assert view["columns"] == 4
    assert view["csv"] == {"delimiter": "semicolon", "encoding": "Windows-1252"}
    chosen = spreadsheets.view(b"a;b,c\n", "x.csv", delimiter="comma")
    assert chosen["rows"] == [["a;b", "c"]] and chosen["csv"]["delimiter"] == "comma"
    with pytest.raises(PdfToolError, match="empty"):
        spreadsheets.view(b"\n", "x.csv")


def test_api_views_a_sheet(client):
    data = workbook(("One", [[1]]), ("Two", [["x", 2]]))
    response = client.post("/api/spreadsheets/view", files={"file": ("book.xlsx", data)}, data={"sheet": "1"})
    assert response.status_code == 200
    assert response.json()["rows"] == [["x", ["2", "n"]]]
    csv_response = client.post("/api/spreadsheets/view", files={"file": ("t.tsv", b"a\tb\n")})
    assert csv_response.json()["csv"]["delimiter"] == "tab"
    bad = client.post("/api/spreadsheets/view", files={"file": ("old.xls", spreadsheets._OLE_MAGIC)})
    assert bad.status_code == 400 and ".xlsx" in bad.json()["detail"]
