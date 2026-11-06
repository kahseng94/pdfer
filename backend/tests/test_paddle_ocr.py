import asyncio
import importlib.util
import json
import shutil
import subprocess
from io import BytesIO
from pathlib import Path

import pikepdf
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageFont

from conftest import make_image, make_pdf
from pdfer import core, ocr, ocr_text, paddle_ocr
from pdfer.api import app

spec = importlib.util.spec_from_file_location("pdfer_paddle_worker", paddle_ocr.RUNTIME / "worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def region(text="Searchable 中文 café 🙂", polygon=None):
    return {"text": text, "polygon": polygon or [[10, 10], [190, 10], [190, 40], [10, 40]], "line": 0}


def result(words=None):
    return {"width": 200, "height": 100, "words": [region()] if words is None else words}


def test_unicode_layer_has_complete_mapping_and_only_invisible_text():
    data = ocr_text.build(result(), 200, 100, 300)
    with pikepdf.open(BytesIO(data)) as pdf:
        page = pdf.pages[0]
        assert list(page.MediaBox) == [0, 0, 48, 24]
        assert not page.Resources.get('/XObject')
        font = page.Resources.Font.OCR
        cmap = font.ToUnicode.read_bytes()
        for character in '中文é🙂':
            assert character.encode('utf-16-be').hex().upper().encode() in cmap
        operations = list(pikepdf.parse_content_stream(page))
        assert [int(values[0]) for values, op in operations if str(op) == 'Tr'] == [3]
        assert set(str(op) for _, op in operations) == {'BT', 'Tr', 'Tf', 'Tm', 'Tj', 'ET'}
        assert not pdf.check_pdf_syntax()


def test_rotated_word_quad_maps_its_baseline_and_ascent_to_the_detected_region():
    # Text climbs toward the right in image coordinates.
    polygon = [[20, 40], [140, 10], [145, 30], [25, 60]]
    data = ocr_text.build(result([region('ABCD', polygon)]), 200, 100, 150)
    with pikepdf.open(BytesIO(data)) as pdf:
        values = next(values for values, op in pikepdf.parse_content_stream(pdf.pages[0]) if str(op) == 'Tm')
        matrix = pikepdf.Matrix(*(float(value) for value in values))
        assert matrix.transform((0, 0)) == pytest.approx((12, 19.2))
        assert matrix.transform((4, 0)) == pytest.approx((69.6, 33.6))
        assert matrix.transform((0, 1)) == pytest.approx((9.6, 28.8))


@pytest.mark.parametrize('bad', [None, {}, {**result(), 'width': 201}, result([{'text': 5}]),
    result([region('\x00')]), result([region('\ud800')]), result([region('a', [[0, 0]] * 4)]),
    result([region('a', [[float('nan'), 0]] * 4)]), result([region('a', [[300, 10]] * 4)])])
def test_invalid_worker_output_is_rejected(bad):
    with pytest.raises(core.PdfToolError): ocr_text.build(bad, 200, 100, 300)


def test_blank_scan_is_a_valid_empty_layer():
    with pikepdf.open(BytesIO(ocr_text.build(result([]), 200, 100, 300))) as pdf:
        assert len(pdf.pages) == 1
        assert pdf.pages[0].Contents.read_bytes() == b''


def test_unicode_layer_is_extractable_by_the_apps_pdfjs_reader(tmp_path):
    reader = Path(core.__file__).resolve().parents[3] / 'frontend/node_modules/pdfjs-dist/legacy/build/pdf.mjs'
    if not shutil.which('node') or not reader.is_file():
        pytest.skip('Install frontend dependencies to run the cross-stack PDF.js check')
    path = tmp_path / 'unicode.pdf'
    path.write_bytes(ocr_text.build(result(), 200, 100, 300))
    script = """
import {readFile} from 'node:fs/promises';
const {getDocument} = await import(process.argv[1]);
const task = getDocument({data:new Uint8Array(await readFile(process.argv[2]))});
const page = await (await task.promise).getPage(1);
console.log(JSON.stringify((await page.getTextContent()).items.filter(i=>'str' in i).map(i=>i.str).join('')));
await task.destroy();
"""
    output = subprocess.run(['node', '--input-type=module', '-e', script, reader.as_uri(), str(path)], capture_output=True, text=True, check=True)
    assert json.loads(output.stdout.strip().splitlines()[-1]) == region()['text']


def test_optional_runtime_absence_does_not_disable_tesseract(monkeypatch, tmp_path):
    monkeypatch.setenv('PDFER_PADDLE_PYTHON', str(tmp_path / 'missing-python'))
    assert ocr.status('paddleocr')['available'] is False
    assert 'pnpm ocr:paddle:setup' in ocr.status('paddleocr')['message']
    monkeypatch.setattr(ocr, '_engine', lambda: '/local/tesseract')
    monkeypatch.setattr(ocr.subprocess, 'run', lambda *a, **k: subprocess.CompletedProcess(a, 0, 'eng\n'))
    assert ocr.status()['languages'] == ['eng']


def test_paddle_rotation_can_use_osd_without_tesseract_recognition_languages(monkeypatch):
    monkeypatch.setattr(paddle_ocr, 'status', lambda: {'available': True, 'languages': ['auto'], 'message': None})
    monkeypatch.setattr(ocr, '_engine', lambda: '/local/tesseract')
    monkeypatch.setattr(ocr.subprocess, 'run', lambda *a, **k: subprocess.CompletedProcess(a, 0, 'osd\n'))
    assert ocr.status()['available'] is False
    assert ocr.status('paddleocr') == {'available': True, 'languages': ['auto'], 'can_rotate': True, 'message': None}


def test_paddle_stays_available_when_tesseract_is_absent(monkeypatch):
    monkeypatch.setattr(paddle_ocr, 'status', lambda: {'available': True, 'languages': ['auto'], 'message': None})
    monkeypatch.setattr(ocr, '_engine', lambda: None)
    assert ocr.status('paddleocr') == {'available': True, 'languages': ['auto'], 'can_rotate': False, 'message': None}


def test_status_rejects_wrong_model_generation_without_loading_paddle(monkeypatch, tmp_path):
    monkeypatch.setattr(worker.importlib.metadata, 'version', lambda name: '3.7.0')
    for model in worker.MODELS:
        folder = tmp_path / model
        folder.mkdir()
        (folder / 'inference.json').write_text('{}')
        (folder / 'inference.pdiparams').write_bytes(b'weights')
        (folder / 'inference.yml').write_text('Global:\n  model_name: PP-OCRv5_server_det\n')
    assert not worker.status(tmp_path)['available']
    for model in worker.MODELS:
        (tmp_path / model / 'inference.yml').write_text(f'Global:\n  model_name: {model}\n')
    assert worker.status(tmp_path) == {'available': True, 'languages': ['auto'], 'message': None}


def test_word_grouping_preserves_punctuation_and_cjk_without_extra_spaces():
    a, b, c = region('')['polygon'], [[191, 10], [195, 10], [195, 40], [191, 40]], [[196, 10], [199, 10], [199, 40], [196, 40]]
    data = {'rec_texts': ['Hello. 中文'], 'rec_polys': [a], 'text_word': [['Hello', '.', '中', '文']], 'text_word_region': [[a, b, b, c]]}
    assert [word['text'] for word in worker.word_regions(data)] == ['Hello.', '中文']
    data['rec_texts'] = ['Hello! 中文']
    assert [word['text'] for word in worker.word_regions(data)] == ['Hello! 中文']


def test_paddle_dispatch_uses_its_worker_and_cleans_tempfiles(monkeypatch):
    monkeypatch.setattr(paddle_ocr, 'status', lambda: {'available': True, 'languages': ['auto']})
    monkeypatch.setattr(paddle_ocr, 'command', lambda: ['paddle-python', 'worker.py'])
    calls = []
    async def disconnected(): return False
    async def run(arguments, callback, **options):
        calls.append((arguments, callback, options))
        output = Path(arguments[arguments.index('--output') + 1])
        output.write_text(json.dumps(result()))
    monkeypatch.setattr(ocr, '_run', run)
    data, rotation = asyncio.run(ocr.recognize(make_image(200, 100), 'auto', 300, disconnected, 'paddleocr'))
    assert calls[0][0][:2] == ['paddle-python', 'worker.py']
    assert calls[0][1] is disconnected
    assert calls[0][2] == {'engine': 'PaddleOCR PP-OCRv6'}
    assert not Path(calls[0][0][-1]).parent.exists()
    assert data.startswith(b'%PDF')
    assert rotation == 0
    with pytest.raises(core.PdfToolError, match='unified multilingual'):
        asyncio.run(ocr.recognize(make_image(10, 10), 'eng', 300, disconnected, 'paddleocr'))


def test_paddle_failure_never_falls_back_to_tesseract(monkeypatch):
    monkeypatch.setattr(paddle_ocr, 'status', lambda: {'available': True, 'languages': ['auto']})
    async def disconnected(): return False
    async def fail(*args, **kwargs): raise core.PdfToolError('PaddleOCR failed')
    monkeypatch.setattr(ocr, '_run', fail)
    monkeypatch.setattr(ocr, '_engine', lambda: pytest.fail('Tesseract must not be used'))
    with pytest.raises(core.PdfToolError, match='PaddleOCR failed'):
        asyncio.run(ocr.recognize(make_image(10, 10), 'auto', 300, disconnected, 'paddleocr'))


def test_api_rejects_unknown_engines_and_reports_selected_availability(monkeypatch):
    monkeypatch.setattr(paddle_ocr, 'status', lambda: {'available': False, 'languages': [], 'message': 'Run setup'})
    client = TestClient(app)
    response = client.get('/api/ocr/status?engine=paddleocr')
    assert response.json()['message'] == 'Run setup'
    assert response.headers['cache-control'] == 'no-store'
    assert client.get('/api/ocr/status?engine=unknown').status_code == 422
    response = client.post('/api/ocr/page', files={'image': ('page.png', make_image(20, 20))}, data={'engine': 'unknown', 'languages': 'auto'})
    assert response.status_code == 422


def test_paddle_layer_uses_existing_password_preserving_assembly():
    source = make_pdf([200, 300], password='secret')
    output = ocr.assemble(source, [ocr_text.build(result(), 200, 100, 300)], '[2]', password='secret')
    with pytest.raises(pikepdf.PasswordError): pikepdf.open(BytesIO(output))
    with pikepdf.open(BytesIO(output), password='secret') as pdf:
        assert len(pdf.pages) == 2
        assert not pdf.pages[0].Resources.get('/XObject')
        assert pdf.pages[1].Resources.XObject


@pytest.mark.skipif(not paddle_ocr.status()['available'], reason='Run pnpm ocr:paddle:setup for the optional native integration test')
def test_real_ppocrv6_recognizes_a_scan_without_tesseract(monkeypatch):
    monkeypatch.setattr(ocr, '_engine', lambda: pytest.fail('PaddleOCR must be independent of Tesseract'))
    image = Image.new('RGB', (1500, 450), 'white')
    font = ImageFont.truetype(str(Path(core.__file__).with_name('fonts') / 'DejaVuSans.ttf'), 64)
    ImageDraw.Draw(image).text((70, 110), 'Local PaddleOCR 12345.', font=font, fill='black')
    raster = BytesIO(); image.save(raster, 'PNG')
    response = TestClient(app).post('/api/ocr/page', files={'image': ('scan.png', raster.getvalue(), 'image/png')},
        data={'engine': 'paddleocr', 'languages': 'auto', 'dpi': 300})
    assert response.status_code == 200, response.text
    with pikepdf.open(BytesIO(response.content)) as pdf:
        assert pdf.pages[0].Resources.Font.OCR.ToUnicode
        assert not pdf.pages[0].Resources.get('/XObject')
        ops = list(pikepdf.parse_content_stream(pdf.pages[0]))
        assert len([op for _, op in ops if str(op) == 'Tj']) >= 3
        assert all(list(values) == [3] for values, op in ops if str(op) == 'Tr')
