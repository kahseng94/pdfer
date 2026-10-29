import json
from io import BytesIO

import pikepdf
import pytest
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin

from pdfer import core, redactions
from pdfer.api import app, redact


def raster():
    image = Image.new('RGBA', (40, 20), (255, 0, 0, 0))
    for x in range(10, 30):
        for y in range(5, 15): image.putpixel((x, y), (0, 0, 0, 255))
    metadata = PngImagePlugin.PngInfo(); metadata.add_text('secret', 'PRIVATE_ORIGINAL_METADATA')
    output = BytesIO(); image.save(output, 'PNG', pnginfo=metadata)
    return output.getvalue()


def test_rebuild_contains_only_pixels_and_discards_image_metadata_and_transparent_rgb():
    output = redactions.rebuild([raster(), raster()], json.dumps([dict(width=612, height=792), dict(width=792, height=612)]))
    assert b'PRIVATE_ORIGINAL_METADATA' not in output
    with pikepdf.open(BytesIO(output)) as pdf:
        assert len(pdf.pages) == 2
        assert not any(key in pdf.Root for key in ('/AcroForm', '/Names', '/Outlines', '/Metadata'))
        assert not pdf.check_pdf_syntax()
        for page in pdf.pages:
            assert '/Font' not in page.Resources and '/Annots' not in page.obj
            assert [str(op) for _, op in pikepdf.parse_content_stream(page)] == ['q', 'cm', 'Do', 'Q']
            image = pikepdf.PdfImage(page.Resources.XObject.PageImage).as_pil_image()
            assert image.getpixel((0, 0)) == (255, 255, 255)
            assert image.getpixel((20, 10)) == (0, 0, 0)
        assert list(pdf.pages[1].MediaBox) == [0, 0, 792, 612]


def test_password_retention_and_size_validation():
    output = redactions.rebuild([raster()], '[{"width":300,"height":200}]', 'secret')
    with pytest.raises(pikepdf.PasswordError): pikepdf.open(BytesIO(output))
    with pikepdf.open(BytesIO(output), password='secret') as pdf: assert len(pdf.pages) == 1
    for spec in ('[]', '[{"width":0,"height":200}]', '[{"width":true,"height":200}]'):
        with pytest.raises(core.PdfToolError): redactions.rebuild([raster()], spec)
    with pytest.raises(core.PdfToolError): redactions.rebuild([b'not a PNG'], '[{"width":300,"height":200}]')


def test_api_builds_a_clean_pdf_from_rendered_pages():
    response = TestClient(app).post('/api/redact', files=[('pages', ('page.png', raster(), 'image/png'))], data={'sizes': '[{"width":300,"height":200}]'})
    assert response.status_code == 200
    assert response.headers['content-type'] == 'application/pdf'
    assert response.headers['cache-control'] == 'no-store'


def test_bounds_reconstructed_streams_as_well_as_uploaded_images(monkeypatch):
    monkeypatch.setattr(redactions, 'MAX_TOTAL_BYTES', 1024)
    monkeypatch.setattr(redactions.zlib, 'compress', lambda pixels: b'x' * 2048)
    with pytest.raises(core.PdfToolError, match='redacted PDF is too large'):
        redactions.rebuild([raster()], '[{"width":300,"height":200}]')


def test_upload_reader_stops_at_total_limit_before_loading_remaining_files(monkeypatch):
    from fastapi import UploadFile
    class Probe(BytesIO):
        def __init__(self, data):
            super().__init__(data)
            self.requests = []
        def read(self, size=-1):
            self.requests.append(size)
            return super().read(size)
    monkeypatch.setattr(redactions, 'MAX_IMAGE_BYTES', 10)
    monkeypatch.setattr(redactions, 'MAX_TOTAL_BYTES', 15)
    streams = [Probe(b'x' * 10) for _ in range(3)]
    with pytest.raises(core.PdfToolError, match='too large'):
        redact([UploadFile(stream) for stream in streams], '[]')
    assert [stream.requests for stream in streams] == [[11], [6], []]
