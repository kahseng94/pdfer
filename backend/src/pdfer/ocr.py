"""Local Tesseract recognition and invisible text layers over the original PDF."""

import asyncio
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
from collections.abc import Awaitable, Callable, Sequence
from decimal import Decimal
from io import BytesIO
from pathlib import Path

import pikepdf
from PIL import Image

from pdfer import core

MAX_SOURCE_BYTES = 128 * 1024 * 1024
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_LAYER_BYTES = 8 * 1024 * 1024
MAX_TOTAL_LAYERS = 64 * 1024 * 1024
MAX_PIXELS = 32_000_000
PAGE_TIMEOUT = 180
ORIENTATION_CONFIDENCE = 15
_SLOTS = threading.BoundedSemaphore(2)
_LANGUAGE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_/-]{0,79}")
_INSTALL = "Install Tesseract and its language data, then check again. On macOS: brew install tesseract."


def _engine() -> str | None:
    return shutil.which(os.environ.get("PDFER_TESSERACT", "tesseract"))


def status() -> dict:
    executable = _engine()
    if not executable:
        return {"available": False, "languages": [], "can_rotate": False, "message": _INSTALL}
    try:
        result = subprocess.run([executable, "--list-langs"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return {"available": False, "languages": [], "can_rotate": False, "message": "Tesseract could not start. Check its installation and try again."}
    installed = {line.strip() for line in result.stdout.splitlines() if _LANGUAGE.fullmatch(line.strip())}
    languages = sorted(installed - {"osd", "equ"})
    if result.returncode or not languages:
        return {"available": False, "languages": [], "can_rotate": False, "message": "No OCR languages are available. Install a Tesseract language pack and check again."}
    return {"available": True, "languages": languages, "can_rotate": "osd" in installed, "message": None}


def _write_image(data: bytes, path: Path) -> None:
    if len(data) > MAX_IMAGE_BYTES:
        raise core.PdfToolError("This page image is too large. Choose 150 DPI or split the PDF first.")
    try:
        with Image.open(BytesIO(data)) as image:
            if image.format != "PNG" or image.width * image.height > MAX_PIXELS:
                raise core.PdfToolError("Provide a PNG page with at most 32 million pixels.")
            # A fresh RGB image discards metadata and guarantees opaque white paper.
            rgba = image.convert("RGBA")
            clean = Image.new("RGB", image.size, "white")
            clean.paste(rgba, mask=rgba.getchannel("A"))
            clean.save(path, "PNG")
    except core.PdfToolError:
        raise
    except Exception:
        raise core.PdfToolError("The page image could not be read.") from None


async def _run(arguments: list[str], disconnected: Callable[[], Awaitable[bool]], *, check: bool = True) -> int:
    """Reap the native process on disconnect, cancellation, timeout, and failure."""
    if await disconnected():
        raise asyncio.CancelledError
    try:
        process = await asyncio.create_subprocess_exec(
            *arguments, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env={**os.environ, "OMP_THREAD_LIMIT": "2"},
        )
    except OSError:
        raise core.PdfToolError("Tesseract could not start. Check its installation and try again.") from None
    wait = asyncio.create_task(process.wait())
    try:
        async with asyncio.timeout(PAGE_TIMEOUT):
            while not wait.done():
                await asyncio.wait({wait}, timeout=0.15)
                if await disconnected():
                    raise asyncio.CancelledError
        if wait.result() and check:
            raise core.PdfToolError("Tesseract could not recognize this page. Check the language packs or try 150 DPI.")
        return wait.result()
    except TimeoutError:
        raise core.PdfToolError("OCR timed out on this page. Try 150 DPI or a smaller page range.") from None
    finally:
        if process.returncode is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(asyncio.shield(wait), 2)
            except TimeoutError:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
        await wait


async def _orientation(path: Path, executable: str, dpi: int, disconnected: Callable[[], Awaitable[bool]]) -> int:
    # Sparse/blank pages often make OSD exit unsuccessfully. Keep their original
    # orientation; cancellation and timeouts still propagate through _run.
    code = await _run([executable, str(path / "page.png"), str(path / "orientation"),
                       "-l", "osd", "--psm", "0", "--dpi", str(dpi)], disconnected, check=False)
    report = path / "orientation.osd"
    if code or not report.is_file() or report.stat().st_size > 4096:
        return 0
    text = report.read_text(encoding="utf-8", errors="replace")
    rotation = re.search(r"^Rotate: (0|90|180|270)\s*$", text, re.MULTILINE)
    confidence = re.search(r"^Orientation confidence: ([0-9]+(?:\.[0-9]+)?)\s*$", text, re.MULTILINE)
    if not rotation or not confidence or float(confidence[1]) < ORIENTATION_CONFIDENCE:
        return 0
    return int(rotation[1])


async def recognize(data: bytes, languages: str, dpi: int, disconnected: Callable[[], Awaitable[bool]], *, rotate: bool = False) -> tuple[bytes, int]:
    if dpi not in (150, 300):
        raise core.PdfToolError("Choose 150 or 300 DPI for OCR.")
    requested = languages.split("+")
    if not 1 <= len(requested) <= 8 or any(not _LANGUAGE.fullmatch(lang) for lang in requested):
        raise core.PdfToolError("Choose between one and eight installed OCR languages.")
    installed = await asyncio.to_thread(status)
    if not installed["available"]:
        raise core.PdfToolError(installed["message"])
    if any(lang not in installed["languages"] for lang in requested):
        raise core.PdfToolError("An OCR language is not installed. Check the available languages and try again.")
    if rotate and not installed.get("can_rotate"):
        raise core.PdfToolError("Automatic rotation needs Tesseract's osd language pack. Install it and check again.")
    while not _SLOTS.acquire(blocking=False):
        if await disconnected():
            raise asyncio.CancelledError
        await asyncio.sleep(0.15)
    try:
        with tempfile.TemporaryDirectory(prefix="pdfer-ocr-") as folder:
            path = Path(folder)
            _write_image(data, path / "page.png")
            executable = _engine()
            if not executable:
                raise core.PdfToolError(_INSTALL)
            rotation = await _orientation(path, executable, dpi, disconnected) if rotate else 0
            if rotation:
                with Image.open(path / "page.png") as image:
                    # Tesseract reports a clockwise correction; Pillow's rotate
                    # uses counterclockwise degrees. Right angles need no resampling.
                    upright = image.transpose({90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_90}[rotation])
                upright.save(path / "page.png", "PNG")
                upright.close()
            await _run([executable, str(path / "page.png"), str(path / "text"),
                        "-l", "+".join(dict.fromkeys(requested)), "--dpi", str(dpi),
                        "-c", "textonly_pdf=1", "pdf"], disconnected)
            output = path / "text.pdf"
            if not output.is_file() or output.stat().st_size > MAX_LAYER_BYTES:
                raise core.PdfToolError("Tesseract did not produce a usable text layer. Try a smaller page.")
            return output.read_bytes(), rotation
    finally:
        _SLOTS.release()


def assemble(data: bytes, layers: Sequence[bytes], spec: str, name="document.pdf", password="", *, rotations: str = "") -> bytes:
    """Place OCR text in the displayed page frame, preserving source objects."""
    if len(data) > MAX_SOURCE_BYTES or sum(map(len, layers)) > MAX_TOTAL_LAYERS or any(len(layer) > MAX_LAYER_BYTES for layer in layers):
        raise core.PdfToolError("This OCR result is too large. Split the document first.")
    try:
        pages = json.loads(spec)
    except ValueError:
        raise core.PdfToolError("OCR pages must be a JSON list of page numbers.") from None
    try:
        corrections = json.loads(rotations) if rotations else [0] * len(layers)
    except ValueError:
        raise core.PdfToolError("OCR rotations must be a JSON list of right-angle corrections.") from None
    with core._open(data, name, password) as pdf:
        if (not isinstance(pages, list) or not 1 <= len(pages) <= 1000 or len(pages) != len(layers)
                or any(type(number) is not int or not 1 <= number <= len(pdf.pages) for number in pages)
                or len(set(pages)) != len(pages)):
            raise core.PdfToolError("Provide one text layer per selected page, without duplicate or out-of-range pages.")
        if (not isinstance(corrections, list) or len(corrections) != len(layers)
                or any(type(angle) is not int or angle not in (0, 90, 180, 270) for angle in corrections)):
            raise core.PdfToolError("Provide one rotation (0, 90, 180 or 270 degrees) per OCR text layer.")
        for number, data, correction in zip(pages, layers, corrections):
            page = pdf.pages[number - 1]
            if correction:
                page.Rotate = (page.rotation + correction) % 360
            with core._open(data, "OCR text layer") as layer:
                if len(layer.pages) != 1:
                    raise core.PdfToolError("Each OCR text layer must contain exactly one page.")
                form = layer.pages[0].as_form_xobject()
                transform = pikepdf.Matrix(*(float(v) for v in form.get("/Matrix", [1, 0, 0, 1, 0, 0])))
                bounds = transform.transform(pikepdf.Rectangle(form.BBox))
                if bounds.width <= 0 or bounds.height <= 0:
                    raise core.PdfToolError("The OCR text layer has an invalid page size.")
                resource = page.add_resource(pdf.copy_foreign(form), pikepdf.Name.XObject, prefix="OCR")
                frame, width, height = core._display_frame(page)
                sx, sy = width / bounds.width, height / bounds.height
                # Scale factors need more precision than the editor's 3-decimal
                # drawing coordinates, especially for pages with /UserUnit.
                scale = [Decimal(str(value)) for value in (sx, 0, 0, sy, -bounds.llx * sx, -bounds.lly * sy)]
                ops = [core._op("q"), ([Decimal(str(value)) for value in frame], pikepdf.Operator("cm")),
                       (scale, pikepdf.Operator("cm")),
                       core._op("Do", resource), core._op("Q")]
                page.contents_add(b"q\n", prepend=True)
                page.contents_add(b"Q\n" + pikepdf.unparse_content_stream(ops))
        return core._save(pdf, password if pdf.is_encrypted else "", min_version="1.6")
