import asyncio
import subprocess
import sys
from io import BytesIO
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageFont

from conftest import make_image, make_pdf
from pdfer import core, ocr, paddle_ocr
from pdfer.api import app


def text_layer(width=300, height=200):
    with pikepdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(width, height))
        page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=pdf.make_indirect(
            pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))))
        page.Contents = pdf.make_stream(b"BT /F1 12 Tf 3 Tr 30 100 Td (Searchable needle) Tj ET")
        return core._save(pdf)


def test_status_handles_missing_engine_and_installed_language_names(monkeypatch):
    monkeypatch.setattr(ocr, "_engine", lambda: None)
    assert ocr.status()["available"] is False
    assert "Install Tesseract" in ocr.status()["message"]
    monkeypatch.setattr(ocr, "_engine", lambda: "/local/tesseract")
    monkeypatch.setattr(ocr.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 0,
        'List of available languages in "/local/tessdata/" (5):\neng\nosd\nfra\nscript/Latin\neng\n'))
    assert ocr.status() == {"available": True, "languages": ["eng", "fra", "script/Latin"], "can_rotate": True, "message": None}


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("unit", [1, 2])
def test_assembly_preserves_content_geometry_structure_and_password(rotation, unit):
    with pikepdf.open(BytesIO(make_pdf([400, 500]))) as pdf:
        page = pdf.pages[0]
        page.CropBox = [10, 20, 310, 180]
        page.Rotate = rotation
        page.UserUnit = unit
        page.Contents = pdf.make_stream(b"0.8 g 10 20 50 50 re f")
        pdf.docinfo["/Title"] = "Original title"
        with pdf.open_outline() as outline:
            outline.root.append(pikepdf.OutlineItem("Chapter", 1))
        widget = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget,
            FT=pikepdf.Name.Tx, T="name", V="Preserved", Rect=[20, 30, 120, 50]))
        page.Annots = [widget]
        pdf.Root.AcroForm = pikepdf.Dictionary(Fields=[widget])
        source = core._save(pdf, "secret")
    result = ocr.assemble(source, [text_layer()], "[1]", password="secret")
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(BytesIO(result))
    with pikepdf.open(BytesIO(result), password="secret") as pdf:
        assert len(pdf.pages) == 2
        page = pdf.pages[0]
        assert list(page.CropBox) == [10, 20, 310, 180]
        assert page.Rotate == rotation and page.UserUnit == unit
        assert str(pdf.docinfo.Title) == "Original title"
        assert str(pdf.Root.AcroForm.Fields[0].V) == "Preserved"
        with pdf.open_outline() as outline:
            assert outline.root[0].title == "Chapter"
        assert b"0.8 g 10 20 50 50 re f" in b"".join(stream.read_bytes() for stream in page.Contents)
        assert len(page.Resources.XObject) == 1
        assert not pdf.pages[1].Resources.get("/XObject")
        assert not pdf.check_pdf_syntax()
        instructions = list(pikepdf.parse_content_stream(page))
        matrices = [pikepdf.Matrix(*(float(value) for value in values)) for values, op in instructions if str(op) == "cm"]
        # Test where the OCR page's lower-left and upper-right corners land.
        # These are independent expectations in the original unrotated crop box.
        corners = {
            0: ((10, 20), (310, 180)), 90: ((310, 20), (10, 180)),
            180: ((310, 180), (10, 20)), 270: ((10, 180), (310, 20)),
        }
        first, last = corners[rotation]
        combined = matrices[1] @ matrices[0]
        assert combined.transform((0, 0)) == pytest.approx(first)
        assert combined.transform((300, 200)) == pytest.approx(last)


@pytest.mark.parametrize("pages", ["bad", "{}", "[]", "[0]", "[3]", "[true]", "[1,1]"])
def test_assembly_rejects_invalid_page_mapping(pages):
    with pytest.raises(core.PdfToolError):
        ocr.assemble(make_pdf([100, 200]), [text_layer()], pages)


def test_assembly_rejects_invalid_layers_and_bounds_uploads(monkeypatch):
    with pytest.raises(core.PdfToolError, match="exactly one"):
        ocr.assemble(make_pdf([100]), [make_pdf([100, 100])], "[1]")
    with pytest.raises(core.PdfToolError, match="valid PDF"):
        ocr.assemble(make_pdf([100]), [b"not a PDF"], "[1]")
    monkeypatch.setattr(ocr, "MAX_SOURCE_BYTES", 10)
    response = TestClient(app).post('/api/ocr/assemble', files=[('file', ('a.pdf', b'x' * 11)), ('layers', ('layer.pdf', b'x'))], data={'pages': '[1]'})
    assert response.status_code == 400 and 'too large' in response.json()['detail']


def test_recognition_cleans_private_tempfiles_and_validates_options(monkeypatch):
    monkeypatch.setattr(ocr, "status", lambda: {"available": True, "languages": ["eng"]})
    monkeypatch.setattr(ocr, "_engine", lambda: "/local/tesseract")
    seen = []

    async def disconnected(): return False

    async def run(arguments, disconnected):
        seen.append(arguments)
        assert Path(arguments[1]).exists()
        Path(arguments[2] + '.pdf').write_bytes(text_layer())

    monkeypatch.setattr(ocr, "_run", run)
    data, rotation = asyncio.run(ocr.recognize(make_image(100, 100), "eng", 300, disconnected))
    assert data.startswith(b"%PDF")
    assert rotation == 0
    assert "textonly_pdf=1" in seen[0]
    assert not Path(seen[0][1]).parent.exists()
    for languages, dpi in [("--bad", 300), ("eng+fra", 300), ("", 300), ("eng", 72)]:
        with pytest.raises(core.PdfToolError):
            asyncio.run(ocr.recognize(make_image(10, 10), languages, dpi, disconnected))
    with pytest.raises(core.PdfToolError, match="could not be read"):
        asyncio.run(ocr.recognize(b"bad PNG", "eng", 300, disconnected))


@pytest.mark.parametrize("kind", ["disconnect", "timeout", "cancel"])
def test_native_process_is_stopped_and_reaped(kind, monkeypatch):
    created = []
    spawn = asyncio.create_subprocess_exec

    async def capture(*args, **kwargs):
        process = await spawn(*args, **kwargs)
        created.append(process)
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", capture)
    if kind == "timeout": monkeypatch.setattr(ocr, "PAGE_TIMEOUT", 0.05)

    async def run():
        async def disconnected(): return bool(created) and kind == "disconnect"
        task = asyncio.create_task(ocr._run([sys.executable, "-c", "import time; time.sleep(30)"], disconnected))
        if kind == "cancel":
            while not created: await asyncio.sleep(0.01)
            task.cancel()
        with pytest.raises(core.PdfToolError if kind == "timeout" else asyncio.CancelledError):
            await task
        assert created[0].returncode is not None

    asyncio.run(run())


def test_api_preserves_password_and_returns_no_store_result():
    response = TestClient(app).post('/api/ocr/assemble', files=[
        ('file', ('scan.pdf', make_pdf([100, 200], password='secret'), 'application/pdf')),
        ('layers', ('text.pdf', text_layer(), 'application/pdf')),
    ], data={'pages': '[2]', 'password': 'secret'})
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    assert 'scan_searchable.pdf' in response.headers['content-disposition']
    with pikepdf.open(BytesIO(response.content), password='secret') as pdf:
        assert len(pdf.pages) == 2
    status = TestClient(app).get('/api/ocr/status')
    assert status.status_code == 200 and status.headers['cache-control'] == 'no-store'


@pytest.mark.skipif(not ocr._engine(), reason="Install Tesseract to run the native OCR integration test")
def test_real_tesseract_recognizes_a_scan_and_produces_invisible_text():
    if 'eng' not in ocr.status()['languages']: pytest.skip('Install the English language pack')
    image = Image.new('RGB', (1500, 450), 'white')
    font = ImageFont.truetype(str(Path(core.__file__).with_name('fonts') / 'DejaVuSans.ttf'), 64)
    draw = ImageDraw.Draw(image)
    draw.text((70, 110), 'Local OCR searchable document', font=font, fill='black')
    raster = BytesIO(); image.save(raster, 'PNG')
    client = TestClient(app)
    response = client.post('/api/ocr/page', files={'image': ('scan.png', raster.getvalue(), 'image/png')}, data={'languages': 'eng', 'dpi': 300})
    assert response.status_code == 200, response.text
    with pikepdf.open(BytesIO(response.content)) as pdf:
        assert len(pdf.pages) == 1
        page = pdf.pages[0]
        assert not page.Resources.get('/XObject')  # No replacement raster in the OCR layer.
        ops = list(pikepdf.parse_content_stream(page))
        assert any(str(op) == 'Tr' and list(values) == [3] for values, op in ops)
        strings = [value for values, op in ops if str(op) == 'TJ' for value in values[0] if isinstance(value, pikepdf.String)]
        strings += [value for values, op in ops if str(op) == 'Tj' for value in values]
        encoded = b''.join(bytes(value) for value in strings)
        assert 'Local' in encoded.decode('utf-16-be')
        assert 'searchable' in encoded.decode('utf-16-be')
    original = core.images_to_pdf([('scan.png', raster.getvalue())])
    output = ocr.assemble(original, [response.content], '[1]')
    with pikepdf.open(BytesIO(output)) as pdf:
        assert not pdf.check_pdf_syntax()


@pytest.mark.parametrize(("report", "expected"), [
    ("Rotate: 90\nOrientation confidence: 15.00\n", 90),
    ("Rotate: 180\nOrientation confidence: 24.50\n", 180),
    ("Rotate: 270\nOrientation confidence: 20.00\n", 270),
    ("Rotate: 90\nOrientation confidence: 14.99\n", 0),
    ("Rotate: 45\nOrientation confidence: 25.00\n", 0),
    ("Rotate: 90\nOrientation confidence: nan\n", 0),
    ("", 0),
    (None, 0),
])
def test_orientation_requires_a_confident_right_angle(report, expected, tmp_path, monkeypatch):
    async def disconnected(): return False

    async def run(arguments, disconnected, *, check=True):
        assert not check and "osd" in arguments
        if report is not None:
            (tmp_path / "orientation.osd").write_text(report)
        return 0 if report else 1  # Tesseract can reject blank/sparse images.

    monkeypatch.setattr(ocr, "_run", run)
    assert asyncio.run(ocr._orientation(tmp_path, "tesseract", 300, disconnected)) == expected


def test_rotation_requires_installed_osd_before_starting_recognition(monkeypatch):
    monkeypatch.setattr(ocr, "status", lambda: {"available": True, "languages": ["eng"], "can_rotate": False})
    async def disconnected(): return False
    with pytest.raises(core.PdfToolError, match="osd"):
        asyncio.run(ocr.recognize(make_image(100, 100), "eng", 300, disconnected, rotate=True))


@pytest.mark.parametrize("rotations", ["bad", "{}", "[]", "[90,0]", "[true]", "[45]", "[-90]", "[360]"])
def test_api_rejects_invalid_rotation_mapping(rotations):
    response = TestClient(app).post('/api/ocr/assemble', files=[
        ('file', ('scan.pdf', make_pdf([100]), 'application/pdf')),
        ('layers', ('text.pdf', text_layer(), 'application/pdf')),
    ], data={'pages': '[1]', 'rotations': rotations})
    assert response.status_code == 400


def rendered_pages(data, password=""):
    rendered = []
    with pdfium.PdfDocument(data, password=password) as pdf:
        for index in range(len(pdf)):
            page = pdf[index]
            try:
                bitmap = page.render(scale=1)
                try:
                    rendered.append((page.get_size(), bitmap.to_pil().tobytes()))
                finally:
                    bitmap.close()
            finally:
                page.close()
    return rendered


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("correction", [0, 90, 180, 270])
@pytest.mark.parametrize("unit", [1, 2])
def test_ocr_preserves_pixels_and_password_with_crop_scale_and_rotation(rotation, correction, unit):
    with pikepdf.open(BytesIO(make_pdf([400, 500]))) as pdf:
        page = pdf.pages[0]
        page.CropBox = [10, 20, 310, 180]
        page.Rotate = rotation
        page.UserUnit = unit
        # Asymmetric artwork makes misplaced or mirrored content visible.
        page.Contents = pdf.make_stream(b"1 0 0 rg 10 20 90 45 re f 0 0 1 rg 180 90 40 70 re f")
        source = core._save(pdf, "private scan")
        page.Rotate = (rotation + correction) % 360
        expected = core._save(pdf, "private scan")
    result = ocr.assemble(source, [text_layer()], '[1]', password="private scan", rotations=f'[{correction}]')
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(BytesIO(result))
    assert rendered_pages(result, "private scan") == rendered_pages(expected, "private scan")
    with pikepdf.open(BytesIO(result), password="private scan") as after:
        assert after.pages[0].Rotate == (rotation + correction) % 360
        assert after.pages[0].UserUnit == unit
        assert list(after.pages[0].CropBox) == [10, 20, 310, 180]
        assert not after.pages[1].get('/Rotate', 0)
        assert not after.pages[1].Resources.get('/XObject')


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("engine", ["tesseract", "paddleocr"])
def test_real_ocr_rotation_keeps_scan_pixels_and_adds_aligned_searchable_text(rotation, engine):
    installed = ocr.status()
    if not installed['available'] or 'eng' not in installed['languages'] or not installed['can_rotate']:
        pytest.skip('Install local Tesseract English and osd language packs')
    if engine == 'paddleocr' and not paddle_ocr.status()['available']:
        pytest.skip('Run pnpm ocr:paddle:setup for the optional native integration test')
    image = Image.new('RGB', (1800, 2400), 'white')
    font = ImageFont.truetype(str(Path(core.__file__).with_name('fonts') / 'DejaVuSans.ttf'), 46)
    draw = ImageDraw.Draw(image)
    lines = ['Automatic rotation test document 4827', 'The quick brown fox jumps over the lazy dog.',
             'This local OCR check uses only synthetic text.', 'Please read this page from the top to the bottom.']
    for index in range(23):
        draw.text((100, 100 + index * 90), lines[index % len(lines)], font=font, fill='black')
    raster = BytesIO(); image.save(raster, 'PNG', dpi=(300, 300))
    with pikepdf.open(BytesIO(core.images_to_pdf([('scan.png', raster.getvalue())]))) as pdf:
        page = pdf.pages[0]
        page.Rotate = rotation
        box = page.MediaBox
        page.CropBox = [3, 3, float(box[2]) - 3, float(box[3]) - 3]
        page.UserUnit = 2
        # Keep a page with existing text and a blank, unselected page untouched.
        with pikepdf.open(BytesIO(text_layer())) as text:
            pdf.pages.extend(text.pages)
        pdf.add_blank_page(page_size=(200, 300))
        source = core._save(pdf, 'secret')
        page.Rotate = 0
        expected = core._save(pdf, 'secret')
    with pdfium.PdfDocument(source, password='secret') as pdf:
        page = pdf[0]
        try:
            bitmap = page.render(scale=300 / 72)
            try:
                raster = BytesIO(); bitmap.to_pil().save(raster, 'PNG')
            finally:
                bitmap.close()
        finally:
            page.close()
    client = TestClient(app)
    response = client.post('/api/ocr/page', files={'image': ('scan.png', raster.getvalue(), 'image/png')},
                           data={'languages': 'auto' if engine == 'paddleocr' else 'eng', 'engine': engine, 'dpi': 300, 'rotate': 'true'})
    assert response.status_code == 200, response.text
    correction = int(response.headers['x-ocr-rotation'])
    assert correction == (360 - rotation) % 360
    response = client.post('/api/ocr/assemble', files=[
        ('file', ('scan.pdf', source, 'application/pdf')), ('layers', ('text.pdf', response.content, 'application/pdf')),
    ], data={'pages': '[1]', 'rotations': f'[{correction}]', 'password': 'secret'})
    assert response.status_code == 200, response.text
    assert rendered_pages(response.content, 'secret') == rendered_pages(expected, 'secret')
    with pdfium.PdfDocument(response.content, password='secret') as pdf:
        page = pdf[0]
        try:
            text = page.get_textpage()
            try:
                content = text.get_text_range()
                assert 'Automatic rotation test document 4827' in content
                # The first line remains near the upper-left of the displayed page.
                left, bottom, right, top = text.get_charbox(content.index('Automatic'))
                width, height = page.get_size()
                assert 0 < left < width / 4 and height * 0.85 < top < height
            finally:
                text.close()
        finally:
            page.close()
