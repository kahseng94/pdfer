"""HTTP API for the local web app.

Most endpoints are plain `def` so FastAPI runs CPU-bound PDF work in a thread
pool. OCR and compression watch disconnects to cancel their local work.
"""

import argparse
import asyncio
import json
import threading
import webbrowser
import zipfile
from collections.abc import Sequence
from io import BytesIO
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from pdfer import bookmarks, core, fonts, forms, metadata, ocr, redactions, signatures

FRONTEND_DIST = Path(__file__).resolve().parents[3] / "frontend" / "dist"

app = FastAPI(title="pdfer")


@app.exception_handler(core.PdfToolError)
def _tool_error(_: Request, exc: core.PdfToolError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(signatures.StoreError)
def _signature_store_error(_: Request, exc: signatures.StoreError) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": str(exc)})


def _signature_access(request: Request) -> None:
    """Keep persistent signature data accessible only to this local app."""
    origin = request.headers.get("origin")
    if (request.url.hostname not in ("127.0.0.1", "localhost", "::1")
            or request.headers.get("sec-fetch-site") == "cross-site"
            or (origin is not None and origin != str(request.base_url).rstrip("/"))):
        raise HTTPException(403, "Open signatures from the local pdfer app.")


_SIGNATURE_HEADERS = {"Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin", "X-Content-Type-Options": "nosniff"}


@app.get("/api/signatures")
def signature_list(request: Request) -> Response:
    _signature_access(request)
    return JSONResponse(signatures.list_signatures(), headers=_SIGNATURE_HEADERS)


@app.post("/api/signatures/prepare")
def signature_prepare(request: Request, file: UploadFile, remove_white: Annotated[bool, Form()] = False) -> Response:
    _signature_access(request)
    image = core.prepare_signature(file.file.read(core.MAX_SIGNATURE_UPLOAD + 1), remove_white=remove_white)
    return Response(image.data, media_type="image/png", headers={**_SIGNATURE_HEADERS, "X-Image-Width": str(image.width), "X-Image-Height": str(image.height)})


@app.post("/api/signatures")
def signature_save(request: Request, file: UploadFile, name: Annotated[str, Form()]) -> Response:
    _signature_access(request)
    name = signatures.validate_name(name)
    image = core.prepare_signature(file.file.read(core.MAX_SIGNATURE_UPLOAD + 1), trim=False)
    return JSONResponse(signatures.save_signature(name, image), status_code=201, headers=_SIGNATURE_HEADERS)


@app.get("/api/signatures/{identifier}/image")
def signature_image(request: Request, identifier: str) -> Response:
    _signature_access(request)
    data = signatures.read_signature(identifier)
    if data is None:
        raise HTTPException(404, "That saved signature was not found.")
    return Response(data, media_type="image/png", headers=_SIGNATURE_HEADERS)


@app.delete("/api/signatures/{identifier}")
def signature_delete(request: Request, identifier: str) -> Response:
    _signature_access(request)
    if not signatures.delete_signature(identifier):
        raise HTTPException(404, "That saved signature was not found.")
    return Response(status_code=204, headers=_SIGNATURE_HEADERS)


def _download(data: bytes, filename: str, media_type: str) -> Response:
    ascii_name = filename.encode("ascii", "replace").decode().replace('"', "")
    disposition = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"
    return Response(data, media_type=media_type, headers={"Content-Disposition": disposition, "Cache-Control": "no-store"})


@app.post("/api/forms/read")
def read_forms(file: UploadFile, password: Annotated[str, Form()] = "") -> Response:
    return JSONResponse(forms.read(file.file.read(), file.filename or "document.pdf", password), headers={"Cache-Control": "no-store"})


@app.post("/api/forms/fill")
def fill_forms(file: UploadFile, values: Annotated[str, Form()], flatten: Annotated[bool, Form()] = False, password: Annotated[str, Form()] = "") -> Response:
    return _download(forms.fill(file.file.read(), values, flatten, file.filename or "document.pdf", password), f"{_stem(file.filename)}_filled.pdf", "application/pdf")


@app.post("/api/bookmarks/read")
def read_bookmarks(file: UploadFile, password: Annotated[str, Form()] = "") -> Response:
    return JSONResponse(bookmarks.read(file.file.read(), file.filename or "document.pdf", password), headers={"Cache-Control": "no-store"})


@app.post("/api/bookmarks")
def write_bookmarks(file: UploadFile, entries: Annotated[str, Form()], password: Annotated[str, Form()] = "") -> Response:
    return _download(bookmarks.write(file.file.read(), entries, file.filename or "document.pdf", password), f"{_stem(file.filename)}_bookmarks.pdf", "application/pdf")


@app.post("/api/metadata/read")
def read_metadata(file: UploadFile, password: Annotated[str, Form()] = "") -> Response:
    return JSONResponse(metadata.read(file.file.read(), file.filename or "document.pdf", password), headers={"Cache-Control": "no-store"})


@app.post("/api/metadata")
def write_metadata(file: UploadFile, changes: Annotated[str, Form()] = "{}", clear: Annotated[bool, Form()] = False, password: Annotated[str, Form()] = "") -> Response:
    return _download(metadata.write(file.file.read(), changes, clear, file.filename or "document.pdf", password), f"{_stem(file.filename)}_metadata.pdf", "application/pdf")


@app.post("/api/redact")
def redact(pages: Annotated[list[UploadFile], File()], sizes: Annotated[str, Form()], password: Annotated[str, Form()] = "") -> Response:
    if len(pages) > 1000:
        raise core.PdfToolError("Split documents longer than 1000 pages before redacting.")
    data = []
    total = 0
    for page in pages:
        limit = min(redactions.MAX_IMAGE_BYTES, redactions.MAX_TOTAL_BYTES - total)
        image = page.file.read(limit + 1)
        if len(image) > limit:
            raise core.PdfToolError("The rendered pages are too large. Use a lower resolution or split the PDF first.")
        total += len(image)
        data.append(image)
    return _download(redactions.rebuild(data, sizes, password), "redacted.pdf", "application/pdf")


@app.get("/api/ocr/status")
def ocr_status(engine: Literal["tesseract", "paddleocr"] = "tesseract") -> Response:
    return JSONResponse(ocr.status(engine), headers={"Cache-Control": "no-store"})


@app.post("/api/ocr/page")
async def ocr_page(request: Request, image: UploadFile, languages: Annotated[str, Form()], dpi: Annotated[int, Form()] = 300, rotate: Annotated[bool, Form()] = False, engine: Annotated[Literal["tesseract", "paddleocr"], Form()] = "tesseract") -> Response:
    data = await image.read(ocr.MAX_IMAGE_BYTES + 1)
    if len(data) > ocr.MAX_IMAGE_BYTES:
        raise core.PdfToolError("This page image is too large. Choose 150 DPI or split the PDF first.")
    output, rotation = await ocr.recognize(data, languages, dpi, request.is_disconnected, engine, rotate=rotate)
    response = _download(output, "text.pdf", "application/pdf")
    response.headers["X-OCR-Rotation"] = str(rotation)
    return response


@app.post("/api/ocr/assemble")
def ocr_assemble(file: UploadFile, layers: Annotated[list[UploadFile], File()], pages: Annotated[str, Form()], password: Annotated[str, Form()] = "", rotations: Annotated[str, Form()] = "") -> Response:
    source = file.file.read(ocr.MAX_SOURCE_BYTES + 1)
    if len(source) > ocr.MAX_SOURCE_BYTES or len(layers) > 1000:
        raise core.PdfToolError("This PDF is too large for OCR. Split it first.")
    contents = []
    total = 0
    for layer in layers:
        limit = min(ocr.MAX_LAYER_BYTES, ocr.MAX_TOTAL_LAYERS - total)
        data = layer.file.read(limit + 1)
        if len(data) > limit:
            raise core.PdfToolError("This OCR result is too large. Split the document first.")
        contents.append(data)
        total += len(data)
    output = ocr.assemble(source, contents, pages, file.filename or "document.pdf", password, rotations=rotations)
    return _download(output, f"{_stem(file.filename)}_searchable.pdf", "application/pdf")


def _stem(filename: str | None) -> str:
    return Path(filename or "").stem or "document"


def _label(r: core.PageRange) -> str:
    start, end = r
    return f"p{start}" if start == end else f"p{start}-{end}"


def _zip(entries: list[tuple[str, bytes]]) -> bytes:
    buf = BytesIO()
    used: dict[str, int] = {}
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries:
            # The same range can be requested twice; keep both files.
            n = used.get(name, 0)
            used[name] = n + 1
            if n:
                name = f"{Path(name).stem} ({n + 1}){Path(name).suffix}"
            zf.writestr(name, data)
    return buf.getvalue()


@app.post("/api/merge")
def merge(files: Annotated[list[UploadFile], File()], passwords: Annotated[str, Form()] = "") -> Response:
    contents = [(f.filename or f"File {i + 1}", f.file.read()) for i, f in enumerate(files)]
    parsed = None
    if passwords:
        try:
            parsed = json.loads(passwords)
        except ValueError:
            raise core.PdfToolError("Passwords must be a JSON list with one password per file.") from None
        if not isinstance(parsed, list):
            raise core.PdfToolError("Passwords must be a JSON list with one password per file.")
    return _download(core.merge(contents, parsed), "merged.pdf", "application/pdf")


@app.post("/api/protect")
def protect(file: UploadFile, new_password: Annotated[str, Form()], password: Annotated[str, Form()] = "") -> Response:
    name = file.filename or "document.pdf"
    out = core.protect(file.file.read(), new_password, name, password)
    return _download(out, f"{_stem(file.filename)}_protected.pdf", "application/pdf")


@app.post("/api/unlock")
def unlock(file: UploadFile, password: Annotated[str, Form()] = "") -> Response:
    name = file.filename or "document.pdf"
    return _download(core.unlock(file.file.read(), name, password), f"{_stem(file.filename)}_unlocked.pdf", "application/pdf")


@app.post("/api/split")
def split(
    file: UploadFile,
    mode: Annotated[Literal["ranges", "each", "extract"], Form()],
    ranges: Annotated[str, Form()] = "",
    password: Annotated[str, Form()] = "",
) -> Response:
    """Split one PDF.

    - ranges: one file per range in `ranges`
    - each: one file per page (`ranges` is ignored)
    - extract: all pages in `ranges` combined into a single file

    A single output comes back as a PDF; several come back as a zip.
    """
    data = file.file.read()
    name = file.filename or "document.pdf"
    stem = _stem(file.filename)
    total = core.page_count(data, name, password)

    if mode == "each":
        page_ranges = [(p, p) for p in range(1, total + 1)]
    else:
        page_ranges = core.parse_ranges(ranges, total)

    if mode == "extract":
        return _download(core.extract(data, page_ranges, name, password), f"{stem}_extract.pdf", "application/pdf")

    parts = core.split(data, page_ranges, name, password)
    names = [f"{stem}_{_label(r)}.pdf" for r in page_ranges]
    if len(parts) == 1:
        return _download(parts[0], names[0], "application/pdf")
    return _download(_zip(list(zip(names, parts))), f"{stem}_split.zip", "application/zip")


@app.post("/api/organize")
def organize(file: UploadFile, pages: Annotated[str, Form()], password: Annotated[str, Form()] = "", layout: Annotated[str, Form()] = "") -> Response:
    """Reorder, rotate and drop pages of one PDF.

    `pages` lists the pages to keep, in order, each with an optional clockwise
    rotation, e.g. "3:90, 1, 2:180". Pages not listed are dropped.
    """
    data = file.file.read()
    name = file.filename or "document.pdf"
    ops = core.parse_page_ops(pages, core.page_count(data, name, password))
    options = core.parse_page_layout(layout, len(ops))
    return _download(core.organize(data, ops, name, password, layout=options), f"{_stem(file.filename)}_organized.pdf", "application/pdf")


@app.post("/api/edit")
def edit(
    file: UploadFile,
    edits: Annotated[str, Form()],
    images: Annotated[list[UploadFile] | None, File()] = None,
    password: Annotated[str, Form()] = "",
) -> Response:
    """Draw text, images and shapes onto pages of one PDF.

    `edits` is a JSON list; see `core.parse_edits` for the fields. Positions
    are in points on the page as displayed, from its top-left corner. Image
    edits refer to `images` by index.
    """
    data = file.file.read()
    name = file.filename or "document.pdf"
    pictures = [(f.filename or f"Image {i + 1}", f.file.read()) for i, f in enumerate(images or [])]
    parsed = core.parse_edits(edits, core.page_count(data, name, password), len(pictures))
    return _download(core.edit(data, parsed, pictures, name, password), f"{_stem(file.filename)}_edited.pdf", "application/pdf")


@app.post("/api/stamp")
def stamp(file: UploadFile, settings: Annotated[str, Form()], password: Annotated[str, Form()] = "") -> Response:
    """Add page numbers and/or a text watermark; the result is also the preview."""
    name = file.filename or "document.pdf"
    out = core.stamp(file.file.read(), settings, name, password)
    return _download(out, f"{_stem(file.filename)}_stamped.pdf", "application/pdf")


@app.get("/api/fonts")
def font_list() -> dict[str, object]:
    """The fonts text edits are set in when they go beyond the standard ones.

    `families` names each family's fonts in fallback order, served by
    `/api/fonts/{name}`; `coverage` lists the code points they have between
    them, as inclusive [first, last] ranges.
    """
    return {
        "families": {family: [f.name for f in fonts.chain(family)] for family in fonts.FAMILIES},
        "coverage": fonts.coverage(),
    }


@app.get("/api/fonts/{name}")
def font_file(name: str) -> Response:
    font = fonts.fonts().get(name)
    if font is None:
        return JSONResponse(status_code=404, content={"detail": f"No font called {name}."})
    return Response(font.path.read_bytes(), media_type="font/ttf", headers={"Cache-Control": "public, max-age=86400"})


@app.post("/api/images")
def images(
    files: Annotated[list[UploadFile], File()],
    paper: Annotated[Literal["image", "a4", "letter"], Form()] = "image",
    orientation: Annotated[Literal["portrait", "landscape"], Form()] = "portrait",
    margin_mm: Annotated[float, Form()] = 10,
    fit: Annotated[Literal["contain", "cover", "stretch"], Form()] = "contain",
) -> Response:
    """One page per image, with optional paper size, margins and fitting."""
    contents = [(f.filename or f"Image {i + 1}", f.file.read()) for i, f in enumerate(files)]
    layout = core.ImagePdfLayout(paper, orientation, margin_mm, fit)
    return _download(core.images_to_pdf(contents, layout), "images.pdf", "application/pdf")


@app.post("/api/compress")
async def compress(
    request: Request, file: UploadFile, level: Annotated[core.CompressLevel, Form()],
    password: Annotated[str, Form()] = "",
    max_bytes: Annotated[int | None, Form(ge=core.MIN_PDF_TARGET, le=core.MAX_PDF_TARGET)] = None,
) -> Response:
    """Shrink one PDF.

    `light` only rewrites the file more compactly. `balanced` and `strong` also
    re-encode raster images as JPEG, downscaled to at most 1600 px or 1000 px.
    The response carries `X-Original-Size` and `X-Compressed-Size` headers in
    bytes; when nothing shrank the original file is returned unchanged.

    With `max_bytes`, try a bounded image-quality ladder, keeping the first
    result within the target or the smallest measured result if unreachable.
    Target headers describe the actual returned bytes; `level` remains the
    fallback when no target is supplied.
    """
    data = await file.read()
    cancelled = threading.Event()
    task = asyncio.create_task(asyncio.to_thread(
        core.compress, data, level, file.filename or "document.pdf", password,
        max_bytes=max_bytes, cancelled=cancelled.is_set,
    ))
    try:
        while not task.done():
            if await request.is_disconnected():
                cancelled.set()
                try:
                    await task
                except core.CompressionCancelled:
                    pass
                return Response(status_code=499)
            await asyncio.wait({task}, timeout=0.1)
        out = await task
    finally:
        cancelled.set()
        # If ASGI itself cancels the handler, consume the eventual worker
        # exception too. Native image encode/save finishes before it can stop.
        if not task.done():
            task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
    res = _download(out, f"{_stem(file.filename)}_compressed.pdf", "application/pdf")
    res.headers["X-Original-Size"] = str(len(data))
    res.headers["X-Compressed-Size"] = str(len(out))
    if max_bytes is not None:
        res.headers["X-Target-Size"] = str(max_bytes)
        res.headers["X-Target-Met"] = str(len(out) <= max_bytes).lower()
    return res


@app.post("/api/photo")
def photo(
    file: UploadFile,
    crop: Annotated[str, Form()],
    width: Annotated[int, Form()],
    height: Annotated[int, Form()],
    dpi: Annotated[int, Form()] = 300,
    max_kb: Annotated[int | None, Form()] = None,
) -> Response:
    """Crop a picture to passport-photo size.

    `crop` is JSON with the centre, size and clockwise angle of the crop in
    pixels of the picture as a browser shows it; see `core.PhotoCrop`. The
    result is a JPEG of `width` × `height` pixels marked `dpi`, kept under
    `max_kb` when given.
    """
    name = file.filename or "photo.jpg"
    max_bytes = max_kb * 1024 if max_kb else None
    out = core.crop_photo(file.file.read(), core.parse_photo_crop(crop), (width, height), dpi, name, max_bytes)
    return _download(out, f"{_stem(file.filename)}_passport.jpg", "image/jpeg")


@app.post("/api/photo-sheet")
def photo_sheet(
    file: UploadFile,
    crop: Annotated[str, Form()],
    photo_width: Annotated[float, Form()],
    photo_height: Annotated[float, Form()],
    paper: Annotated[core.Paper, Form()] = "4x6",
) -> Response:
    """A printable sheet with as many copies of the cropped photo as fit.

    `photo_width` and `photo_height` are the printed size in millimetres and
    `paper` is `4x6`, `a4` or `letter`. The PDF has one page at 300 dpi with
    cut lines between the photos; the `X-Copies` header says how many are on it.
    """
    name = file.filename or "photo.jpg"
    out, copies = core.photo_sheet(
        file.file.read(), core.parse_photo_crop(crop), (photo_width, photo_height), paper, name
    )
    res = _download(out, f"{_stem(file.filename)}_passport_sheet.pdf", "application/pdf")
    res.headers["X-Copies"] = str(copies)
    return res


@app.post("/api/compress-images")
def compress_images(
    files: Annotated[list[UploadFile], File()],
    level: Annotated[core.CompressLevel, Form()],
    fmt: Annotated[core.ImageFormat, Form(alias="format")] = "keep",
    max_kb: Annotated[int | None, Form()] = None,
) -> Response:
    """Shrink one or more pictures.

    `level` is as for `/api/compress`; `format` is `keep`, `jpeg`, `png` or
    `webp`; `max_kb` keeps lowering quality, then size, until each file fits.
    One picture comes back as an image, several as a zip. `X-Original-Size`
    and `X-Compressed-Size` give the totals in bytes and `X-Results` a JSON
    list of `{"name", "before", "after"}` per picture, names percent-encoded.
    """
    max_bytes = max_kb * 1024 if max_kb else None
    results = [
        core.compress_image(f.filename or f"Image {i + 1}", f.file.read(), level, fmt, max_bytes)
        for i, f in enumerate(files)
    ]
    if len(results) == 1:
        only = results[0]
        res = _download(only.data, only.name, only.media_type)
    else:
        res = _download(_zip([(r.name, r.data) for r in results]), "images_compressed.zip", "application/zip")
    res.headers["X-Original-Size"] = str(sum(r.before for r in results))
    res.headers["X-Compressed-Size"] = str(sum(r.after for r in results))
    res.headers["X-Results"] = json.dumps(
        [{"name": quote(r.name), "before": r.before, "after": r.after} for r in results]
    )
    return res


# Serve the built frontend when it exists, so `pdfer` alone runs the whole app.
if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="pdfer", description="Local PDF tools in your browser.")
    parser.add_argument("--port", type=int, default=8000, help="port to listen on (default: 8000)")
    parser.add_argument("--no-browser", action="store_true", help="don't open the browser")
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    url = f"http://127.0.0.1:{args.port}"
    if FRONTEND_DIST.is_dir() and not args.no_browser:
        # Give uvicorn a moment to bind before the browser knocks.
        timer = threading.Timer(1.0, webbrowser.open, [url])
        timer.daemon = True
        timer.start()
    uvicorn.run(app, host="127.0.0.1", port=args.port)
