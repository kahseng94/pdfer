"""Local OCR engines and invisible text layers over the original PDF."""

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

from pdfer import core, ocr_text, paddle_ocr

MAX_SOURCE_BYTES = 128 * 1024 * 1024
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_LAYER_BYTES = 8 * 1024 * 1024
MAX_TOTAL_LAYERS = 64 * 1024 * 1024
MAX_PIXELS = 32_000_000
PAGE_TIMEOUT = 180
_SLOTS = threading.BoundedSemaphore(2)
_LANGUAGE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_/-]{0,79}")
_INSTALL = "Install Tesseract and its language data, then check again. On macOS: brew install tesseract."


def _engine() -> str | None:
    return shutil.which(os.environ.get("PDFER_TESSERACT", "tesseract"))


def status(engine: str = "tesseract") -> dict:
    if engine == "paddleocr":
        return paddle_ocr.status()
    if engine != "tesseract":
        raise core.PdfToolError("Choose Tesseract or PaddleOCR PP-OCRv6.")
    executable = _engine()
    if not executable:
        return {"available": False, "languages": [], "message": _INSTALL}
    try:
        result = subprocess.run([executable, "--list-langs"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return {"available": False, "languages": [], "message": "Tesseract could not start. Check its installation and try again."}
    languages = sorted({line.strip() for line in result.stdout.splitlines()
                        if _LANGUAGE.fullmatch(line.strip()) and line.strip() not in ("osd", "equ")})
    if result.returncode or not languages:
        return {"available": False, "languages": [], "message": "No OCR languages are available. Install a Tesseract language pack and check again."}
    return {"available": True, "languages": languages, "message": None}


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


async def _run(arguments: list[str], disconnected: Callable[[], Awaitable[bool]], *, engine: str = "Tesseract") -> None:
    """Reap the native process on disconnect, cancellation, timeout, and failure."""
    if await disconnected():
        raise asyncio.CancelledError
    try:
        process = await asyncio.create_subprocess_exec(
            *arguments, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env={**os.environ, "OMP_THREAD_LIMIT": "2"},
        )
    except OSError:
        raise core.PdfToolError(f"{engine} could not start. Check its installation and try again.") from None
    wait = asyncio.create_task(process.wait())
    try:
        async with asyncio.timeout(PAGE_TIMEOUT):
            while not wait.done():
                await asyncio.wait({wait}, timeout=0.15)
                if await disconnected():
                    raise asyncio.CancelledError
        if wait.result():
            raise core.PdfToolError(f"{engine} could not recognize this page. Check its setup or try 150 DPI.")
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


async def recognize(data: bytes, languages: str, dpi: int, disconnected: Callable[[], Awaitable[bool]], engine: str = "tesseract") -> bytes:
    if dpi not in (150, 300):
        raise core.PdfToolError("Choose 150 or 300 DPI for OCR.")
    if engine not in ("tesseract", "paddleocr"):
        raise core.PdfToolError("Choose Tesseract or PaddleOCR PP-OCRv6.")
    if engine == "paddleocr" and languages != "auto":
        raise core.PdfToolError("PP-OCRv6 uses its unified multilingual model. Choose automatic language recognition.")
    requested = languages.split("+")
    if not 1 <= len(requested) <= 8 or any(not _LANGUAGE.fullmatch(lang) for lang in requested):
        raise core.PdfToolError("Choose between one and eight installed OCR languages.")
    installed = await asyncio.to_thread(paddle_ocr.status if engine == "paddleocr" else status)
    if not installed["available"]:
        raise core.PdfToolError(installed["message"])
    if any(lang not in installed["languages"] for lang in requested):
        raise core.PdfToolError("An OCR language is not installed. Check the available languages and try again.")
    while not _SLOTS.acquire(blocking=False):
        if await disconnected():
            raise asyncio.CancelledError
        await asyncio.sleep(0.15)
    try:
        with tempfile.TemporaryDirectory(prefix="pdfer-ocr-") as folder:
            path = Path(folder)
            _write_image(data, path / "page.png")
            if engine == "paddleocr":
                await _run([*paddle_ocr.command(), "--image", str(path / "page.png"), "--output", str(path / "words.json")],
                           disconnected, engine="PaddleOCR PP-OCRv6")
                words = path / "words.json"
                if not words.is_file() or words.stat().st_size > MAX_LAYER_BYTES:
                    raise core.PdfToolError("PaddleOCR did not produce a usable text layer. Try a smaller page.")
                try:
                    result = json.loads(words.read_text(encoding="utf-8"))
                except (ValueError, UnicodeError):
                    raise core.PdfToolError("PaddleOCR returned unreadable recognition results.") from None
                with Image.open(path / "page.png") as image:
                    output = ocr_text.build(result, *image.size, dpi)
                if len(output) > MAX_LAYER_BYTES:
                    raise core.PdfToolError("The OCR text layer is too large. Try a smaller page.")
                return output
            executable = _engine()
            if not executable:
                raise core.PdfToolError(_INSTALL)
            await _run([executable, str(path / "page.png"), str(path / "text"),
                        "-l", "+".join(dict.fromkeys(requested)), "--dpi", str(dpi),
                        "-c", "textonly_pdf=1", "pdf"], disconnected)
            output = path / "text.pdf"
            if not output.is_file() or output.stat().st_size > MAX_LAYER_BYTES:
                raise core.PdfToolError("Tesseract did not produce a usable text layer. Try a smaller page.")
            return output.read_bytes()
    finally:
        _SLOTS.release()


def assemble(data: bytes, layers: Sequence[bytes], spec: str, name="document.pdf", password="") -> bytes:
    """Place OCR text in the displayed page frame, preserving source objects."""
    if len(data) > MAX_SOURCE_BYTES or sum(map(len, layers)) > MAX_TOTAL_LAYERS or any(len(layer) > MAX_LAYER_BYTES for layer in layers):
        raise core.PdfToolError("This OCR result is too large. Split the document first.")
    try:
        pages = json.loads(spec)
    except ValueError:
        raise core.PdfToolError("OCR pages must be a JSON list of page numbers.") from None
    with core._open(data, name, password) as pdf:
        if (not isinstance(pages, list) or not 1 <= len(pages) <= 1000 or len(pages) != len(layers)
                or any(type(number) is not int or not 1 <= number <= len(pdf.pages) for number in pages)
                or len(set(pages)) != len(pages)):
            raise core.PdfToolError("Provide one text layer per selected page, without duplicate or out-of-range pages.")
        for number, data in zip(pages, layers):
            page = pdf.pages[number - 1]
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
