import asyncio
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile
from contextlib import closing
from io import BytesIO
from pathlib import Path

import pikepdf
import pytest
from fastapi.testclient import TestClient

from conftest import make_pdf
from pdfer import office
from pdfer.api import app
from pdfer.core import PdfToolError


def package(kind="word"):
    stream = BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr({"word": "word/document.xml", "excel": "xl/workbook.xml", "powerpoint": "ppt/presentation.xml"}[kind], "<document/>")
    return stream.getvalue()


async def connected():
    return False


@pytest.mark.parametrize("kind,extension,export_filter", [
    ("word", "docx", "writer_pdf_Export"), ("word", "doc", "writer_pdf_Export"),
    ("excel", "xlsx", "calc_pdf_Export"), ("excel", "xls", "calc_pdf_Export"),
    ("powerpoint", "pptx", "impress_pdf_Export"), ("powerpoint", "ppt", "impress_pdf_Export"),
])
def test_conversion_isolated_and_cleaned(monkeypatch, kind, extension, export_filter):
    monkeypatch.setattr(office, "_engine", lambda: "/local/soffice")
    source = package(kind) if extension.endswith("x") else office._OLE_MAGIC + b"fixture"
    output = make_pdf([400, 500])
    folders = []

    async def run(arguments, disconnected):
        assert arguments[0] == "/local/soffice"
        assert arguments[arguments.index("--convert-to") + 1] == f"pdf:{export_filter}"
        assert "--headless" in arguments
        path = Path(arguments[-1])
        assert path.name == f"document.{extension}"
        assert path.read_bytes() == source
        folders.append(path.parent)
        profile = path.parent / "profile"
        assert f"-env:UserInstallation={profile.as_uri()}" in arguments
        settings = ET.parse(profile / "user/registrymodifications.xcu").getroot()
        namespace = "{http://openoffice.org/2001/registry}"
        values = {(item.attrib[namespace + "path"], prop.attrib[namespace + "name"]): prop.findtext("value")
                  for item in settings for prop in item}
        assert values[("/org.openoffice.Office.Common/Security/Scripting", "DisableMacrosExecution")] == "true"
        assert values[("/org.openoffice.Office.Common/Security/Scripting", "DisableActiveContent")] == "true"
        assert values[("/org.openoffice.Office.Writer/Content/Update", "Link")] == "2"
        assert values[("/org.openoffice.Office.Calc/Content/Update", "Link")] == "1"
        outdir = Path(arguments[arguments.index("--outdir") + 1])
        (outdir / "document.pdf").write_bytes(output)

    monkeypatch.setattr(office, "_run", run)
    actual = asyncio.run(office.convert(source, f"../../Untrusted Name.{extension.upper()}", kind, connected))
    assert actual == output
    assert all(not path.exists() for path in folders)


@pytest.mark.parametrize("filename,kind,data,message", [
    ("bad.docx", "word", b"", "empty"),
    ("bad.txt", "word", b"text", "matching"),
    ("bad.docx", "excel", package(), "matching"),
    ("bad.docx", "word", b"not a zip", "not a valid"),
    ("bad.docx", "word", package("excel"), "selected type"),
    ("bad.xls", "excel", b"text", "not a valid"),
    ("locked.xlsx", "excel", office._OLE_MAGIC, "password protected"),
])
def test_rejects_invalid_input_before_launch(monkeypatch, filename, kind, data, message):
    monkeypatch.setattr(office, "_engine", lambda: pytest.fail("must validate before finding engine"))
    with pytest.raises(PdfToolError, match=message):
        asyncio.run(office.convert(data, filename, kind, connected))


def test_limits_input_and_unpacked_data(monkeypatch):
    monkeypatch.setattr(office, "MAX_SOURCE_BYTES", 5)
    with pytest.raises(PdfToolError, match="128 MB"):
        office._validate(b"123456", "a.docx", "word")
    monkeypatch.setattr(office, "MAX_SOURCE_BYTES", 10240)
    monkeypatch.setattr(office, "MAX_UNPACKED_BYTES", 5)
    with pytest.raises(PdfToolError, match="expands"):
        office._validate(package(), "a.docx", "word")


def test_engine_override_and_missing_status(monkeypatch):
    monkeypatch.setenv("PDFER_LIBREOFFICE", "/missing/libreoffice")
    monkeypatch.setattr(office.shutil, "which", lambda value: None)
    assert office._engine() is None
    assert office.status() == {"available": False, "message": office._INSTALL}
    with pytest.raises(PdfToolError, match="Install LibreOffice"):
        asyncio.run(office.convert(package(), "a.docx", "word", connected))


def test_discovers_desktop_install_without_path(monkeypatch):
    monkeypatch.delenv("PDFER_LIBREOFFICE", raising=False)
    expected = "/Applications/LibreOffice.app/Contents/MacOS/soffice"
    monkeypatch.setattr(office.shutil, "which", lambda candidate: expected if candidate == expected else None)
    assert office._engine() == expected


def test_status_handles_broken_engine(monkeypatch):
    monkeypatch.setattr(office, "_engine", lambda: "/local/soffice")
    monkeypatch.setattr(office.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 1))
    assert office.status()["available"] is False
    monkeypatch.setattr(office.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 0))
    assert office.status() == {"available": True, "message": None}


@pytest.mark.parametrize("contents,message", [(None, "No PDF"), (b"not a pdf", "readable PDF"), (make_pdf([]), "readable PDF")])
def test_rejects_missing_or_invalid_output(tmp_path, contents, message):
    path = tmp_path / "document.pdf"
    if contents is not None:
        path.write_bytes(contents)
    with pytest.raises(PdfToolError, match=message):
        office._read_output(path)


def test_limits_output(tmp_path, monkeypatch):
    path = tmp_path / "document.pdf"
    path.write_bytes(make_pdf([300]))
    monkeypatch.setattr(office, "MAX_OUTPUT_BYTES", 1)
    with pytest.raises(PdfToolError, match="too large"):
        office._read_output(path)


def test_run_times_out_and_reaps_process(monkeypatch):
    monkeypatch.setattr(office, "CONVERSION_TIMEOUT", 0.1)
    with pytest.raises(PdfToolError, match="timed out"):
        asyncio.run(office._run([sys.executable, "-c", "import time; time.sleep(30)"], connected))


def test_run_cancels_after_disconnect():
    calls = 0

    async def disconnected():
        nonlocal calls
        calls += 1
        return calls > 1

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(office._run([sys.executable, "-c", "import time; time.sleep(30)"], disconnected))
    assert calls == 2


def test_run_reports_failure_and_start_errors():
    with pytest.raises(PdfToolError, match="could not convert"):
        asyncio.run(office._run([sys.executable, "-c", "raise SystemExit(2)"], connected))
    with pytest.raises(PdfToolError, match="could not start"):
        asyncio.run(office._run(["/nonexistent/soffice"], connected))


def test_cleanup_and_slot_release_on_failure(monkeypatch):
    monkeypatch.setattr(office, "_engine", lambda: "soffice")
    folders = []

    async def fail(arguments, disconnected):
        folders.append(Path(arguments[-1]).parent)
        raise PdfToolError("Failed")

    monkeypatch.setattr(office, "_run", fail)
    for _ in range(3):
        with pytest.raises(PdfToolError, match="Failed"):
            asyncio.run(office.convert(package(), "a.docx", "word", connected))
    assert all(not folder.exists() for folder in folders)


def test_office_api_filename_bytes_and_no_store(monkeypatch):
    output = make_pdf([300])

    async def convert(data, filename, kind, disconnected):
        assert data == b"source"
        assert filename == "résumé.docx"
        assert kind == "word"
        return output

    monkeypatch.setattr(office, "convert", convert)
    client = TestClient(app)
    response = client.post("/api/office", files={"file": ("../../résumé.docx", b"source")}, data={"kind": "word"})
    assert response.status_code == 200
    assert response.content == output
    assert response.headers["content-type"] == "application/pdf"
    assert "r%C3%A9sum%C3%A9.pdf" in response.headers["content-disposition"]
    assert response.headers["cache-control"] == "no-store"


def test_api_status_errors_and_bounded_upload(monkeypatch):
    client = TestClient(app)
    monkeypatch.setattr(office, "_engine", lambda: None)
    response = client.get("/api/office/status")
    assert response.json()["available"] is False
    assert response.headers["cache-control"] == "no-store"
    response = client.post("/api/office", files={"file": ("a.docx", package())}, data={"kind": "word"})
    assert response.status_code == 400
    assert "Install LibreOffice" in response.json()["detail"]
    assert client.post("/api/office", files={"file": ("a.docx", package())}, data={"kind": "png"}).status_code == 422
    monkeypatch.setattr(office, "MAX_SOURCE_BYTES", 8)
    response = client.post("/api/office", files={"file": ("a.docx", b"x" * 100)}, data={"kind": "word"})
    assert response.status_code == 400
    assert "128 MB" in response.json()["detail"]


@pytest.mark.skipif(not office._engine(), reason="LibreOffice is not installed")
@pytest.mark.parametrize("kind,extension,pages,expected", [
    ("word", "docx", 2, "Word conversion fixture"), ("word", "doc", 2, "Word conversion fixture"),
    ("excel", "xlsx", 1, "Excel conversion fixture"), ("excel", "xls", 1, "Excel conversion fixture"),
    ("powerpoint", "pptx", 2, "PowerPoint conversion fixture"), ("powerpoint", "ppt", 2, "PowerPoint conversion fixture"),
])
@pytest.mark.timeout(60)
def test_real_libreoffice_conversion(kind, extension, pages, expected):
    import pypdfium2

    fixture = Path(__file__).parent / "fixtures/office" / f"{kind}.{extension}"
    output = asyncio.run(office.convert(fixture.read_bytes(), fixture.name, kind, connected))
    with pikepdf.open(BytesIO(output)) as pdf:
        assert len(pdf.pages) == pages
    with pypdfium2.PdfDocument(output) as pdf:
        with closing(pdf[0]) as page:
            with closing(page.get_textpage()) as text:
                assert expected in text.get_text_range()
                if kind == "excel":
                    assert "Total" in text.get_text_range()
                    assert "20" in text.get_text_range()
