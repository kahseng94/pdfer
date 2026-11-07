"""Convert Office documents with a locally installed LibreOffice."""

import asyncio
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import zipfile
from collections.abc import Awaitable, Callable
from io import BytesIO
from pathlib import Path

import pikepdf

from pdfer.core import PdfToolError

MAX_SOURCE_BYTES = 128 * 1024 * 1024
MAX_OUTPUT_BYTES = 256 * 1024 * 1024
MAX_UNPACKED_BYTES = 512 * 1024 * 1024
CONVERSION_TIMEOUT = 180
_SLOTS = threading.BoundedSemaphore(2)
_INSTALL = "Install LibreOffice to convert Word, Excel and PowerPoint files, then check again."
_FORMATS = {
    ".doc": ("word", "writer_pdf_Export", None),
    ".docx": ("word", "writer_pdf_Export", "word/document.xml"),
    ".xls": ("excel", "calc_pdf_Export", None),
    ".xlsx": ("excel", "calc_pdf_Export", "xl/workbook.xml"),
    ".ppt": ("powerpoint", "impress_pdf_Export", None),
    ".pptx": ("powerpoint", "impress_pdf_Export", "ppt/presentation.xml"),
}
_OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def _engine() -> str | None:
    override = os.environ.get("PDFER_LIBREOFFICE")
    if override:
        return shutil.which(override)
    candidates = [
        "soffice", "libreoffice",
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        str(Path.home() / "Applications/LibreOffice.app/Contents/MacOS/soffice"),
    ]
    for key in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        if os.environ.get(key):
            base = Path(os.environ[key]) / "LibreOffice/program"
            candidates.extend(str(base / name) for name in ("soffice.com", "soffice.exe"))
    return next((found for candidate in candidates if (found := shutil.which(candidate))), None)


def _environment() -> dict[str, str]:
    env = dict(os.environ)
    # A PyInstaller backend must not inject its bundled libraries into LibreOffice.
    if "LD_LIBRARY_PATH_ORIG" in env:
        env["LD_LIBRARY_PATH"] = env["LD_LIBRARY_PATH_ORIG"]
    elif getattr(sys, "frozen", False):
        env.pop("LD_LIBRARY_PATH", None)
    return env


def status() -> dict:
    executable = _engine()
    if not executable:
        return {"available": False, "message": _INSTALL}
    try:
        result = subprocess.run([executable, "--version"], stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=10, env=_environment())
    except (OSError, subprocess.TimeoutExpired):
        result = None
    available = result is not None and result.returncode == 0
    return {"available": available, "message": None if available else "LibreOffice could not start. Check its installation and try again."}


def _validate(data: bytes, filename: str, kind: str) -> tuple[str, str]:
    suffix = Path(filename).suffix.lower()
    spec = _FORMATS.get(suffix)
    if spec is None or spec[0] != kind:
        raise PdfToolError("Choose a matching Word (.doc, .docx), Excel (.xls, .xlsx) or PowerPoint (.ppt, .pptx) file.")
    if not data:
        raise PdfToolError("This document is empty. Choose a file with content.")
    if len(data) > MAX_SOURCE_BYTES:
        raise PdfToolError("Office files must be 128 MB or smaller. Split this document first.")
    if spec[2] is None:
        if not data.startswith(_OLE_MAGIC):
            raise PdfToolError("This is not a valid Office document. Open it in Office and save it as .docx, .xlsx or .pptx.")
    else:
        if data.startswith(_OLE_MAGIC):
            raise PdfToolError("This Office file may be password protected. Save an unprotected copy in Office before converting.")
        try:
            with zipfile.ZipFile(BytesIO(data)) as archive:
                entries = archive.infolist()
                if len(entries) > 10000 or sum(item.file_size for item in entries) > MAX_UNPACKED_BYTES:
                    raise PdfToolError("This document expands to too much data. Split it before converting.")
                if any(item.flag_bits & 1 for item in entries):
                    raise PdfToolError("Save an unprotected copy of this Office file before converting.")
                names = {item.filename for item in entries}
                if "[Content_Types].xml" not in names or spec[2] not in names:
                    raise ValueError
        except PdfToolError:
            raise
        except (zipfile.BadZipFile, ValueError, OSError):
            raise PdfToolError("This is not a valid Office document of the selected type. Open it in Office and save a new copy.") from None
    return suffix, spec[1]


def _profile(path: Path) -> None:
    user = path / "user"
    user.mkdir(parents=True)
    # A fresh, private profile avoids sharing a running GUI session. Do not run
    # document macros or update linked content while opening uploaded documents.
    # Writer's "never" link-update mode is 2; Calc uses 1 for the same setting.
    (user / "registrymodifications.xcu").write_text('''<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop><prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop></item>
 <item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
 <item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item>
</oor:items>''', encoding="utf-8")


async def _run(arguments: list[str], disconnected: Callable[[], Awaitable[bool]]) -> None:
    if await disconnected():
        raise asyncio.CancelledError
    try:
        process = await asyncio.create_subprocess_exec(
            *arguments, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env=_environment(), start_new_session=os.name != "nt",
        )
    except OSError:
        raise PdfToolError("LibreOffice could not start. Check its installation and try again.") from None
    wait = asyncio.create_task(process.wait())
    try:
        async with asyncio.timeout(CONVERSION_TIMEOUT):
            while not wait.done():
                await asyncio.wait({wait}, timeout=0.15)
                if await disconnected():
                    raise asyncio.CancelledError
        if wait.result():
            raise PdfToolError("LibreOffice could not convert this document. Open it in Office, remove any password and save a new copy.")
    except TimeoutError:
        raise PdfToolError("Conversion timed out. Try a smaller document or save a new copy in Office.") from None
    finally:
        if process.returncode is None:
            try:
                if os.name == "nt":
                    # soffice may launch a child process; stop the entire job.
                    await asyncio.to_thread(subprocess.run, ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
                else:
                    os.killpg(process.pid, signal.SIGKILL)
            except (OSError, subprocess.TimeoutExpired):
                pass
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
        await wait


def _read_output(path: Path) -> bytes:
    if not path.is_file():
        raise PdfToolError("No PDF was produced. The file may be damaged or password protected. Save a new, unprotected copy in Office and try again.")
    if path.stat().st_size > MAX_OUTPUT_BYTES:
        raise PdfToolError("The converted PDF is too large. Split the source document first.")
    data = path.read_bytes()
    try:
        with pikepdf.open(BytesIO(data)) as pdf:
            if not len(pdf.pages):
                raise ValueError
    except (pikepdf.PdfError, ValueError):
        raise PdfToolError("LibreOffice did not produce a readable PDF. Save a new copy of the document and try again.") from None
    return data


async def convert(data: bytes, filename: str, kind: str, disconnected: Callable[[], Awaitable[bool]]) -> bytes:
    suffix, export_filter = await asyncio.to_thread(_validate, data, filename, kind)
    executable = _engine()
    if not executable:
        raise PdfToolError(_INSTALL)
    while not _SLOTS.acquire(blocking=False):
        if await disconnected():
            raise asyncio.CancelledError
        await asyncio.sleep(0.15)
    try:
        with tempfile.TemporaryDirectory(prefix="pdfer-office-") as folder:
            root = Path(folder)
            profile = root / "profile"
            _profile(profile)
            source = root / f"document{suffix}"
            source.write_bytes(data)
            output = root / "output"
            output.mkdir()
            await _run([executable, f"-env:UserInstallation={profile.as_uri()}",
                        "--headless", "--nologo", "--nodefault", "--nofirststartwizard", "--norestore",
                        "--convert-to", f"pdf:{export_filter}", "--outdir", str(output), str(source)], disconnected)
            if await disconnected():
                raise asyncio.CancelledError
            return await asyncio.to_thread(_read_output, output / "document.pdf")
    except OSError:
        raise PdfToolError("Could not create the PDF. Check available disk space and try again.") from None
    finally:
        _SLOTS.release()
