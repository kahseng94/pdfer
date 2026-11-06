import asyncio
import threading
from io import BytesIO

import pikepdf
import pypdfium2 as pdfium
import pytest
from conftest import images, make_image_pdf, make_pdf
from fastapi import UploadFile
from fastapi.testclient import TestClient

from pdfer import api, core


def test_reachable_target_keeps_page_content_and_stops_above_floor(image_pdf):
    target = len(core.compress(image_pdf, "strong")) + 100
    out = core.compress(image_pdf, "light", max_bytes=target)
    assert len(out) <= target < len(image_pdf)
    assert images(out)[0][1] >= 1000
    with pikepdf.open(BytesIO(image_pdf)) as original, pikepdf.open(BytesIO(out)) as result:
        assert result.pages[0].Contents.read_bytes() == original.pages[0].Contents.read_bytes()
        assert list(result.pages[0].MediaBox) == list(original.pages[0].MediaBox)


def test_unreachable_target_returns_measured_best_and_respects_floor(image_pdf):
    out = core.compress(image_pdf, "balanced", max_bytes=1000)
    assert 1000 < len(out) < len(image_pdf)
    assert images(out)[0][1:3] == (800, 800)


def test_already_small_returns_exact_original_but_still_validates_password():
    source = make_pdf([101], password="secret")
    assert core.compress(source, "strong", password="secret", max_bytes=len(source)) == source
    with pytest.raises(core.PdfToolError, match="incorrect"):
        core.compress(source, "strong", password="wrong", max_bytes=len(source))
    with pytest.raises(core.PdfToolError, match="valid PDF"):
        core.compress(b"not a PDF", "strong", max_bytes=1000)


def test_encrypted_target_result_keeps_opening_password():
    source = core.protect(make_image_pdf(side=1000), "secret")
    out = core.compress(source, "balanced", password="secret", max_bytes=100_000)
    assert len(out) < len(source)
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(BytesIO(out))
    with pikepdf.open(BytesIO(out), password="secret") as pdf:
        assert len(pdf.pages) == 1
        assert pdf.is_encrypted


def text_document():
    with pikepdf.new() as pdf:
        font = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
        for index in range(30):
            page = pdf.add_blank_page(page_size=(612, 792))
            page.CropBox = [10, 20, 600, 770]
            page.Rotate = 90 if index % 2 else 0
            page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
            page.Contents = pdf.make_stream(f"BT /F1 14 Tf 50 100 Td (Searchable page {index + 1}) Tj ET 1 0 0 RG 10 20 50 60 re S".encode())
        with pdf.open_outline() as outline:
            outline.root.append(pikepdf.OutlineItem("Chapter", 0))
        output = BytesIO()
        pdf.save(output)
        return output.getvalue()


def test_text_only_unreachable_retains_text_vectors_boxes_rotation_and_bookmarks():
    source = text_document()
    out = core.compress(source, "strong", max_bytes=1000)
    assert 1000 < len(out) <= len(source)
    with pikepdf.open(BytesIO(source)) as before, pikepdf.open(BytesIO(out)) as after:
        assert len(after.pages) == len(before.pages) == 30
        for left, right in zip(before.pages, after.pages):
            assert left.Contents.read_bytes() == right.Contents.read_bytes()
            assert list(left.CropBox) == list(right.CropBox)
            assert list(left.MediaBox) == list(right.MediaBox)
            assert left.Rotate == right.Rotate
            assert right.Resources.Font.F1.BaseFont == pikepdf.Name.Helvetica
        with after.open_outline() as outline:
            assert outline.root[0].title == "Chapter"
    with pdfium.PdfDocument(out) as document:
        assert "Searchable page 1" in document[0].get_textpage().get_text_range()


def test_search_is_bounded_uses_source_and_keeps_best_even_when_sizes_are_not_monotonic(monkeypatch):
    source = b"original" * 1000
    seen = []
    sizes = iter([7000, 6000, 3000, 4000, 5000, 3500, 4500])
    def candidate(data, _name, _password, choice, _cancelled, **_kwargs):
        assert data is source
        seen.append(choice)
        return b"x" * next(sizes)
    monkeypatch.setattr(core, "_compress_candidate", candidate)
    assert len(core.compress(source, "light", max_bytes=1000)) == 3000
    assert len(seen) == 7
    assert seen[-1] == (800, 50)


def test_search_stops_at_first_fitting_candidate(monkeypatch):
    seen = []
    def candidate(_data, _name, _password, choice, _cancelled, **_kwargs):
        seen.append(choice)
        return b"x" * (1500 if choice is None else 1000)
    monkeypatch.setattr(core, "_compress_candidate", candidate)
    assert len(core.compress(b"original" * 1000, "strong", max_bytes=1000)) == 1000
    assert seen == [None, (2400, 90)]


@pytest.mark.parametrize("target", [0, -1, 999, 500_000_001, 1000.5, float("nan"), float("inf"), True])
def test_core_rejects_invalid_targets(target):
    with pytest.raises(core.PdfToolError, match="PDF target"):
        core.compress(b"unused", "balanced", max_bytes=target)


def test_cancellation_does_not_return_an_intermediate_candidate(monkeypatch):
    cancelled = threading.Event()
    calls = []
    def candidate(*_args, **_kwargs):
        calls.append(1)
        cancelled.set()
        return b"partial"
    monkeypatch.setattr(core, "_compress_candidate", candidate)
    with pytest.raises(core.CompressionCancelled):
        core.compress(b"original" * 1000, "light", max_bytes=1000, cancelled=cancelled.is_set)
    assert len(calls) == 1


@pytest.mark.parametrize("target", ["999", "500000001", "-1", "NaN", "Infinity", "1000.5", "2 MB"])
def test_api_rejects_invalid_targets(target):
    response = TestClient(api.app).post("/api/compress", files={"file": ("test.pdf", make_pdf([101]))}, data={"level": "balanced", "max_bytes": target})
    assert response.status_code == 422


@pytest.mark.parametrize("target", [1000, 100_000, 500_000_000])
def test_api_reports_only_measured_sizes(target):
    source = text_document()
    response = TestClient(api.app).post("/api/compress", files={"file": ("test.pdf", source)}, data={"level": "balanced", "max_bytes": target})
    assert response.status_code == 200
    assert int(response.headers["x-original-size"]) == len(source)
    assert int(response.headers["x-compressed-size"]) == len(response.content)
    assert int(response.headers["x-target-size"]) == target
    assert response.headers["x-target-met"] == str(len(response.content) <= target).lower()


def test_disconnect_stops_worker_without_publishing_partial_pdf(monkeypatch):
    entered = threading.Event()
    stopped = threading.Event()
    def compress(*_args, cancelled, **_kwargs):
        entered.set()
        while not cancelled():
            stopped.wait(0.005)
        stopped.set()
        raise core.CompressionCancelled()
    class Disconnected:
        async def is_disconnected(self):
            await asyncio.to_thread(entered.wait, 2)
            return True
    monkeypatch.setattr(core, "compress", compress)
    response = asyncio.run(api.compress(Disconnected(), UploadFile(filename="test.pdf", file=BytesIO(b"source")), "balanced", max_bytes=1000))
    assert response.status_code == 499
    assert not response.body
    assert stopped.is_set()
