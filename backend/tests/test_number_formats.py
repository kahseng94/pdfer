import datetime

import pytest

from pdfer.number_formats import display, general

ACCOUNTING = '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)'


@pytest.mark.parametrize("value,number_format,shown", [
    (1234.5, '"$"#,##0.00', "$1,234.50"),
    (1234.5, "#,##0", "1,235"),
    (2.5, "0", "3"),
    (0.15, "0%", "15%"),
    (0.1234, "0.00%", "12.34%"),
    (-1234.5, "#,##0.00;[Red](#,##0.00)", "(1,234.50)"),
    (-1234.5, "#,##0.00", "-1,234.50"),
    (0, '#,##0;-#,##0;"-"', "-"),
    (0, "0;-0;;@", ""),
    (1234567, '0.0,,"M"', "1.2M"),
    (1234567, "#,##0,", "1,235"),
    (12345.678, "0.00E+00", "1.23E+04"),
    (0.000123, "0.0E+0", "1.2E-4"),
    (99999, "0.0E+00", "1.0E+05"),
    (5, "0.##", "5."),
    (5.25, "0.0#", "5.25"),
    (0.5, "#.00", ".50"),
    (42, "00000", "00042"),
    (1234.5, ACCOUNTING, "$1,234.50"),
    (-3, ACCOUNTING, "$(3.00)"),
    (0, ACCOUNTING, "$-"),
    (1234.5, "#,##0.00 [$€-407]", "1,234.50 €"),
    (3.5, '0.0 "kg"', "3.5 kg"),
    (7, '"Item "0', "Item 7"),
    (7, r"0\x", "7x"),
    (1.5, "General", "1.5"),
    (-1.5, "General", "-1.5"),
    (0.1 + 0.2, "General", "0.3"),
    (1234.5, None, "1234.5"),
    (1234.5, "", "1234.5"),
    (5, '"High"', "High"),
])
def test_number_formats_show_values_as_excel_does(value, number_format, shown):
    assert display(value, number_format) == shown


@pytest.mark.parametrize("number_format", ["[>100]0;0", "# ?/?", "mm:ss", "@", "000-00-0000\"x\"0"])
def test_formats_beyond_this_module_fall_back_to_the_true_value(number_format):
    assert display(7, number_format) == "7"


@pytest.mark.parametrize("value,number_format,shown", [
    (datetime.datetime(2026, 1, 2, 13, 5, 9), "d-mmm-yy h:mm AM/PM", "2-Jan-26 1:05 PM"),
    (datetime.datetime(2026, 1, 2, 0, 5, 9), "h:mm am/pm", "12:05 am"),
    (datetime.datetime(2026, 1, 2, 13, 5, 9), "yyyy-mm-dd hh:mm:ss", "2026-01-02 13:05:09"),
    (datetime.datetime(2026, 11, 7), "dddd, mmmm d, yyyy", "Saturday, November 7, 2026"),
    (datetime.datetime(2026, 11, 7), "ddd d mmm", "Sat 7 Nov"),
    (datetime.datetime(2026, 11, 7), "mm/dd/yyyy", "11/07/2026"),
    (datetime.datetime(2026, 11, 7), "mmmmm", "N"),
    (datetime.datetime(2026, 3, 4), "d/m", "4/3"),
    (datetime.datetime(2026, 11, 7, 0, 3), "[$-409]mmm-yy", "Nov-26"),
    (datetime.datetime(2026, 11, 7), "General", "2026-11-07"),
    (datetime.datetime(2026, 11, 7, 8, 15), "General", "2026-11-07 08:15:00"),
    (datetime.date(2026, 11, 7), 'yyyy"年"m"月"d"日"', "2026年11月7日"),
    (datetime.time(9, 5, 30, 250000), "h:mm:ss.00", "9:05:30.25"),
    (datetime.time(14, 30), "h:mm a/p", "2:30 p"),
    (datetime.time(14, 30), "[h]:mm", "14:30"),
])
def test_date_formats(value, number_format, shown):
    assert display(value, number_format) == shown


def test_general_matches_csv_export():
    assert general(True) == "TRUE"
    assert general(1e15) == "1e+15"
    assert general(datetime.timedelta(hours=26, minutes=30)) == "26:30:00"
    assert general(None) == ""
    assert display("text", "0.00") == "text"
    assert display(False, "0") == "FALSE"
