import json
import zipfile
from io import BytesIO

import pytest
from conftest import images, instructions, make_image, make_pdf, rotations, widths, xobjects
from fastapi.testclient import TestClient
from PIL import Image

from pdfer.api import app, parse_args


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def pdf_upload(name: str, data: bytes) -> tuple[str, bytes, str]:
    return (name, data, "application/pdf")


def unzip(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(BytesIO(data)) as zf:
        return {n: zf.read(n) for n in zf.namelist()}


def test_merge(client):
    files = [
        ("files", pdf_upload("b.pdf", make_pdf([201]))),
        ("files", pdf_upload("a.pdf", make_pdf([101, 102]))),
    ]
    res = client.post("/api/merge", files=files)
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    assert 'filename="merged.pdf"' in res.headers["content-disposition"]
    assert widths(res.content) == [201, 101, 102]


def test_merge_error_is_400_with_detail(client):
    files = [("files", pdf_upload("a.pdf", make_pdf([101]))), ("files", pdf_upload("bad.pdf", b"nope"))]
    res = client.post("/api/merge", files=files)
    assert res.status_code == 400
    assert res.json() == {"detail": "bad.pdf isn't a valid PDF."}


def test_split_ranges_returns_zip(client, ten_pages):
    res = client.post(
        "/api/split",
        files={"file": pdf_upload("report.pdf", ten_pages)},
        data={"mode": "ranges", "ranges": "1-3, 5, 5"},
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/zip"
    assert 'filename="report_split.zip"' in res.headers["content-disposition"]
    entries = unzip(res.content)
    assert list(entries) == ["report_p1-3.pdf", "report_p5.pdf", "report_p5 (2).pdf"]
    assert widths(entries["report_p1-3.pdf"]) == [101, 102, 103]


def test_split_single_range_returns_pdf(client, ten_pages):
    res = client.post(
        "/api/split",
        files={"file": pdf_upload("report.pdf", ten_pages)},
        data={"mode": "ranges", "ranges": "4-6"},
    )
    assert res.headers["content-type"] == "application/pdf"
    assert 'filename="report_p4-6.pdf"' in res.headers["content-disposition"]
    assert widths(res.content) == [104, 105, 106]


def test_split_each_page(client):
    res = client.post(
        "/api/split",
        files={"file": pdf_upload("x.pdf", make_pdf([101, 102, 103]))},
        data={"mode": "each", "ranges": "ignored"},
    )
    entries = unzip(res.content)
    assert list(entries) == ["x_p1.pdf", "x_p2.pdf", "x_p3.pdf"]


def test_extract(client, ten_pages):
    res = client.post(
        "/api/split",
        files={"file": pdf_upload("report.pdf", ten_pages)},
        data={"mode": "extract", "ranges": "10, 1-2"},
    )
    assert res.headers["content-type"] == "application/pdf"
    assert 'filename="report_extract.pdf"' in res.headers["content-disposition"]
    assert widths(res.content) == [110, 101, 102]


def test_bad_ranges_is_400(client, ten_pages):
    res = client.post(
        "/api/split",
        files={"file": pdf_upload("report.pdf", ten_pages)},
        data={"mode": "ranges", "ranges": "3-20"},
    )
    assert res.status_code == 400
    assert res.json() == {"detail": '"3-20" is outside pages 1-10.'}


def test_unknown_mode_is_rejected(client, ten_pages):
    res = client.post(
        "/api/split",
        files={"file": pdf_upload("report.pdf", ten_pages)},
        data={"mode": "explode"},
    )
    assert res.status_code == 422


def test_non_ascii_filename(client):
    res = client.post(
        "/api/split",
        files={"file": pdf_upload("résumé.pdf", make_pdf([101, 102]))},
        data={"mode": "ranges", "ranges": "1"},
    )
    assert "filename*=UTF-8''r%C3%A9sum%C3%A9_p1.pdf" in res.headers["content-disposition"]


def test_organize(client, ten_pages):
    res = client.post(
        "/api/organize",
        files={"file": pdf_upload("report.pdf", ten_pages)},
        data={"pages": "3:90, 1, 1:180"},
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    assert 'filename="report_organized.pdf"' in res.headers["content-disposition"]
    assert widths(res.content) == [103, 101, 101]
    assert rotations(res.content) == [90, 0, 180]


def test_organize_bad_pages_is_400(client, ten_pages):
    res = client.post(
        "/api/organize",
        files={"file": pdf_upload("report.pdf", ten_pages)},
        data={"pages": "2:45"},
    )
    assert res.status_code == 400
    assert res.json() == {"detail": '"2:45" needs a rotation of 0, 90, 180 or 270.'}


def test_images(client):
    files = [
        ("files", ("a.png", make_image(96, 192), "image/png")),
        ("files", ("b.jpg", make_image(192, 96, "JPEG"), "image/jpeg")),
    ]
    res = client.post("/api/images", files=files)
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    assert 'filename="images.pdf"' in res.headers["content-disposition"]
    assert widths(res.content) == [72, 144]


def test_images_error_is_400_with_detail(client):
    res = client.post("/api/images", files=[("files", ("notes.txt", b"hello", "text/plain"))])
    assert res.status_code == 400
    assert res.json() == {"detail": "notes.txt isn't an image pdfer can read."}


def test_edit(client, ten_pages):
    edits = [
        {"type": "text", "page": 1, "x": 10, "y": 20, "text": "Hello", "size": 12, "color": "#000000"},
        {"type": "image", "page": 2, "x": 0, "y": 0, "width": 10, "height": 5, "image": 0},
    ]
    res = client.post(
        "/api/edit",
        files=[("file", pdf_upload("report.pdf", ten_pages)), ("images", ("a.png", make_image(8, 4), "image/png"))],
        data={"edits": json.dumps(edits)},
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    assert 'filename="report_edited.pdf"' in res.headers["content-disposition"]
    assert widths(res.content) == widths(ten_pages)
    assert (["Hello"], "Tj") in instructions(res.content, 0)
    assert xobjects(res.content, 1) == [("/FlateDecode", 8, 4, "/DeviceRGB", False)]


def test_edit_without_images(client, ten_pages):
    edits = [{"type": "highlight", "page": 3, "x": 0, "y": 0, "width": 10, "height": 5, "color": "#ffff00"}]
    res = client.post("/api/edit", files={"file": pdf_upload("report.pdf", ten_pages)}, data={"edits": json.dumps(edits)})
    assert res.status_code == 200
    assert "gs" in [op for _, op in instructions(res.content, 2)]


def test_edit_bad_edits_is_400(client, ten_pages):
    edits = [{"type": "image", "page": 1, "x": 0, "y": 0, "width": 10, "height": 5, "image": 0}]
    res = client.post("/api/edit", files={"file": pdf_upload("report.pdf", ten_pages)}, data={"edits": json.dumps(edits)})
    assert res.status_code == 400
    assert res.json() == {"detail": "Edit 1 refers to an image that wasn't uploaded."}


def test_compress(client, image_pdf):
    res = client.post(
        "/api/compress",
        files={"file": pdf_upload("photos.pdf", image_pdf)},
        data={"level": "balanced"},
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    assert 'filename="photos_compressed.pdf"' in res.headers["content-disposition"]
    assert res.headers["x-original-size"] == str(len(image_pdf))
    assert res.headers["x-compressed-size"] == str(len(res.content))
    assert len(res.content) < len(image_pdf)
    assert images(res.content) == [("/DCTDecode", 1600, 1600, "/DeviceRGB")]


def test_compress_returns_original_when_nothing_shrinks(client):
    tiny = make_pdf([101])
    res = client.post("/api/compress", files={"file": pdf_upload("tiny.pdf", tiny)}, data={"level": "light"})
    assert res.status_code == 200
    assert res.headers["x-original-size"] == str(len(tiny))
    assert int(res.headers["x-compressed-size"]) == len(res.content) <= len(tiny)


def test_compress_bad_pdf_is_400(client):
    res = client.post("/api/compress", files={"file": pdf_upload("bad.pdf", b"nope")}, data={"level": "strong"})
    assert res.status_code == 400
    assert res.json() == {"detail": "bad.pdf isn't a valid PDF."}


def test_compress_unknown_level_is_rejected(client, image_pdf):
    res = client.post("/api/compress", files={"file": pdf_upload("x.pdf", image_pdf)}, data={"level": "extreme"})
    assert res.status_code == 422


def test_parse_args():
    defaults = parse_args([])
    assert (defaults.port, defaults.no_browser) == (8000, False)
    args = parse_args(["--no-browser", "--port", "9000"])
    assert (args.port, args.no_browser) == (9000, True)


def quadrant_photo() -> tuple[str, bytes, str]:
    img = Image.new("RGB", (400, 300), (255, 0, 0))
    img.paste((0, 0, 255), (0, 150, 400, 300))
    buf = BytesIO()
    img.save(buf, "JPEG")
    return ("IMG_0001.jpg", buf.getvalue(), "image/jpeg")


CROP = json.dumps({"cx": 200, "cy": 150, "width": 240, "height": 300, "angle": 0})


def test_photo(client):
    res = client.post(
        "/api/photo",
        files={"file": quadrant_photo()},
        data={"crop": CROP, "width": 413, "height": 531, "dpi": "300"},
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/jpeg"
    assert 'filename="IMG_0001_passport.jpg"' in res.headers["content-disposition"]
    img = Image.open(BytesIO(res.content))
    assert (img.format, img.size, img.info["dpi"]) == ("JPEG", (413, 531), (300, 300))
    assert img.getpixel((200, 100))[0] > 200  # red on top
    assert img.getpixel((200, 450))[2] > 200  # blue below


def test_photo_max_kb(client):
    res = client.post(
        "/api/photo",
        files={"file": quadrant_photo()},
        data={"crop": CROP, "width": 600, "height": 600, "dpi": "600", "max_kb": "8"},
    )
    assert res.status_code == 200
    assert len(res.content) <= 8 * 1024


def test_photo_bad_crop_is_400(client):
    res = client.post("/api/photo", files={"file": quadrant_photo()}, data={"crop": "{}", "width": 10, "height": 10})
    assert res.status_code == 400
    assert res.json() == {"detail": "The crop needs a number for cx."}


def test_photo_unreadable_is_400(client):
    res = client.post(
        "/api/photo",
        files={"file": ("notes.txt", b"hello", "text/plain")},
        data={"crop": CROP, "width": 10, "height": 10},
    )
    assert res.status_code == 400
    assert res.json() == {"detail": "notes.txt isn't an image pdfer can read."}


def test_photo_missing_size_is_rejected(client):
    res = client.post("/api/photo", files={"file": quadrant_photo()}, data={"crop": CROP})
    assert res.status_code == 422


def test_photo_sheet(client):
    res = client.post(
        "/api/photo-sheet",
        files={"file": quadrant_photo()},
        data={"crop": CROP, "photo_width": "35", "photo_height": "45", "paper": "4x6"},
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    assert 'filename="IMG_0001_passport_sheet.pdf"' in res.headers["content-disposition"]
    assert res.headers["x-copies"] == "6"
    assert widths(res.content) == [288]


def test_photo_sheet_unknown_paper_is_rejected(client):
    res = client.post(
        "/api/photo-sheet",
        files={"file": quadrant_photo()},
        data={"crop": CROP, "photo_width": "35", "photo_height": "45", "paper": "b5"},
    )
    assert res.status_code == 422


def test_photo_sheet_too_big_is_400(client):
    res = client.post(
        "/api/photo-sheet",
        files={"file": quadrant_photo()},
        data={"crop": CROP, "photo_width": "120", "photo_height": "120", "paper": "4x6"},
    )
    assert res.status_code == 400
    assert res.json() == {"detail": "The photo doesn't fit on that paper."}


def noisy_jpeg(name: str = "photo.jpg", side: int = 800) -> tuple[str, bytes, str]:
    img = Image.merge("RGB", [Image.effect_noise((side, side), 80) for _ in range(3)])
    buf = BytesIO()
    img.save(buf, "JPEG", quality=95)
    return (name, buf.getvalue(), "image/jpeg")


def test_compress_one_image(client):
    name, data, _ = noisy_jpeg()
    res = client.post("/api/compress-images", files=[("files", (name, data, "image/jpeg"))], data={"level": "strong"})
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/jpeg"
    assert 'filename="photo_compressed.jpg"' in res.headers["content-disposition"]
    assert res.headers["x-original-size"] == str(len(data))
    assert res.headers["x-compressed-size"] == str(len(res.content)) and len(res.content) < len(data)
    assert json.loads(res.headers["x-results"]) == [
        {"name": "photo_compressed.jpg", "before": len(data), "after": len(res.content)}
    ]


def test_compress_several_images_returns_zip(client):
    files = [("files", noisy_jpeg("a.jpg")), ("files", noisy_jpeg("a.jpg")), ("files", noisy_jpeg("ü b.jpg", 300))]
    res = client.post(
        "/api/compress-images", files=files, data={"level": "balanced", "format": "webp", "max_kb": "200"}
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/zip"
    assert 'filename="images_compressed.zip"' in res.headers["content-disposition"]
    entries = unzip(res.content)
    assert list(entries) == ["a_compressed.webp", "a_compressed (2).webp", "ü b_compressed.webp"]
    results = json.loads(res.headers["x-results"])
    assert [r["name"] for r in results] == ["a_compressed.webp", "a_compressed.webp", "%C3%BC%20b_compressed.webp"]
    assert all(r["after"] <= 200 * 1024 for r in results)
    assert int(res.headers["x-compressed-size"]) == sum(r["after"] for r in results)


def test_compress_images_bad_format_is_rejected(client):
    res = client.post("/api/compress-images", files=[("files", noisy_jpeg())], data={"level": "light", "format": "gif"})
    assert res.status_code == 422


def test_compress_images_unreadable_is_400(client):
    res = client.post(
        "/api/compress-images", files=[("files", ("notes.txt", b"hello", "text/plain"))], data={"level": "light"}
    )
    assert res.status_code == 400
    assert res.json() == {"detail": "notes.txt isn't an image pdfer can read."}
