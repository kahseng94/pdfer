from io import BytesIO
import os

import pikepdf
import pytest
from conftest import make_pdf
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from pdfer import core, signatures
from pdfer.api import app


def ink_image(mode="RGBA", size=(300, 120), background=(0, 0, 0, 0), fmt="PNG", **kwargs):
    image = Image.new(mode, size, background)
    ImageDraw.Draw(image).line([(40, 80), (80, 25), (110, 85), (180, 45), (240, 70)], fill=(20, 40, 90, 255) if mode == "RGBA" else (20, 40, 90), width=5)
    output = BytesIO(); image.save(output, fmt, **kwargs)
    return output.getvalue()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PDFER_DATA_DIR", str(tmp_path))
    return TestClient(app, base_url="http://127.0.0.1")


def test_signature_normalization_crops_transparent_edges_and_strips_metadata():
    result = core.prepare_signature(ink_image())
    image = Image.open(BytesIO(result.data))
    assert image.format == "PNG" and image.mode == "RGBA"
    assert result.width < 300 and result.height < 120
    assert image.getpixel((0, 0))[3] == 0
    assert image.getchannel("A").getbbox() == (8, 8, result.width - 8, result.height - 8)
    assert not image.getexif()


def test_white_removal_preserves_antialiased_ink_on_white():
    source = Image.new("RGBA", (4, 1))
    pixels = [(255,255,255,255),(128,128,128,255),(10,40,180,255),(10,40,180,128)]
    source.putdata(pixels)
    buffer = BytesIO(); source.save(buffer, "PNG")
    output = core.prepare_signature(buffer.getvalue(), remove_white=True, trim=False)
    image = Image.open(BytesIO(output.data))
    assert image.getpixel((0,0))[3] == 0
    assert image.getpixel((1,0))[3] < 255
    white = Image.new("RGBA", source.size, "white")
    before = Image.alpha_composite(white, source).convert("RGB")
    after = Image.alpha_composite(white, image).convert("RGB")
    for x in range(4):
        assert max(abs(a-b) for a,b in zip(before.getpixel((x,0)), after.getpixel((x,0)))) <= 2


def test_import_respects_exif_rotation_and_limits_dimensions():
    exif = Image.Exif(); exif[0x0112] = 6
    source = ink_image("RGB", (300,120), "white", "JPEG", exif=exif)
    image = core.prepare_signature(source, trim=False)
    assert (image.width, image.height) == (120,300)
    big = Image.new("RGBA", (1800, 900), (10,20,30,255))
    buffer = BytesIO(); big.save(buffer, "PNG")
    prepared = core.prepare_signature(buffer.getvalue())
    assert max(prepared.width, prepared.height) <= 1600
    saved = core.prepare_signature(prepared.data, trim=False)
    assert saved.data == prepared.data


@pytest.mark.parametrize("data, remove_white", [(b"not an image", False), (b"x" * (core.MAX_SIGNATURE_UPLOAD+1), False)])
def test_bad_signature_images_are_rejected(data, remove_white):
    with pytest.raises(core.PdfToolError): core.prepare_signature(data, remove_white=remove_white)


def test_blank_signatures_are_rejected():
    for background, remove in [((0,0,0,0), False), ((255,255,255,255), True)]:
        buffer = BytesIO(); Image.new("RGBA", (100,50), background).save(buffer, "PNG")
        with pytest.raises(core.PdfToolError, match="blank"): core.prepare_signature(buffer.getvalue(), remove_white=remove)


def test_library_roundtrip_persists_without_browser_state_and_deletes(client):
    assert client.get("/api/signatures").json() == []
    assert not signatures.library_path().exists()
    prepared = client.post("/api/signatures/prepare", files={"file": ("signature.jpg", ink_image("RGB", background="white", fmt="JPEG"), "image/jpeg")}, data={"remove_white": "true"})
    assert prepared.status_code == 200
    response = client.post("/api/signatures", files={"file": ("signature.png", prepared.content, "image/png")}, data={"name": "  Work signature  "})
    assert response.status_code == 201
    record = response.json()
    assert record["name"] == "Work signature"
    assert record["width"] == int(prepared.headers["x-image-width"])
    second = TestClient(app, base_url="http://127.0.0.1")
    assert second.get("/api/signatures").json() == [record]
    image = second.get(f"/api/signatures/{record['id']}/image")
    assert image.content == prepared.content
    assert image.headers["cache-control"] == "no-store"
    assert image.headers["cross-origin-resource-policy"] == "same-origin"
    if os.name != "nt":
        assert signatures.library_path().stat().st_mode & 0o777 == 0o600
        assert signatures.library_path().parent.stat().st_mode & 0o777 == 0o700
    assert client.delete(f"/api/signatures/{record['id']}").status_code == 204
    assert second.get("/api/signatures").json() == []
    assert second.get(f"/api/signatures/{record['id']}/image").status_code == 404


def test_same_names_do_not_overwrite_saved_signatures(client):
    records = [client.post("/api/signatures", files={"file": ("s.png", ink_image(), "image/png")}, data={"name": "My signature"}).json() for _ in range(2)]
    assert records[0]["id"] != records[1]["id"]
    assert len(client.get("/api/signatures").json()) == 2


@pytest.mark.parametrize("name", ["   ", "x"*81, "bad\x00name"])
def test_invalid_names_do_not_create_a_library(client, name):
    response = client.post("/api/signatures", files={"file": ("s.png", ink_image(), "image/png")}, data={"name": name})
    assert response.status_code == 400
    assert not signatures.library_path().exists()


@pytest.mark.parametrize("headers", [{"origin":"https://example.com"}, {"origin":"null"}, {"host":"attacker.example"}, {"sec-fetch-site":"cross-site"}])
def test_library_rejects_cross_origin_and_untrusted_host_requests(client, headers):
    assert client.get("/api/signatures", headers=headers).status_code == 403
    assert client.post("/api/signatures", files={"file": ("s.png", ink_image(), "image/png")}, data={"name":"Private"}, headers=headers).status_code == 403
    assert not signatures.library_path().exists()


def test_same_origin_requests_are_allowed(client):
    assert client.get("/api/signatures", headers={"origin":"http://127.0.0.1"}).status_code == 200


def test_signature_identifiers_cannot_query_other_rows(client):
    saved = client.post("/api/signatures", files={"file": ("s.png", ink_image(), "image/png")}, data={"name":"Private"}).json()
    assert client.get("/api/signatures/' OR 1=1 --/image").status_code == 404
    assert client.delete("/api/signatures/' OR 1=1 --").status_code == 404
    assert client.get("/api/signatures").json() == [saved]


def test_storage_failures_are_reported_without_a_false_success(client, tmp_path, monkeypatch):
    blocked = tmp_path / "not-a-directory"
    blocked.write_text("keep")
    monkeypatch.setenv("PDFER_DATA_DIR", str(blocked))
    response = client.post("/api/signatures", files={"file": ("s.png", ink_image(), "image/png")}, data={"name":"Private"})
    assert response.status_code == 503
    assert str(tmp_path) not in response.text
    assert blocked.read_text() == "keep"


def test_transparent_signature_edits_preserve_password_and_use_pdf14_or_newer():
    source = make_pdf([612], password="secret")
    signature = core.prepare_signature(ink_image())
    output = core.edit(source, [core.ImageEdit(page=1,x=100,y=100,width=180,height=60,image=0)], [("signature.png", signature.data)], password="secret")
    with pytest.raises(pikepdf.PasswordError): pikepdf.open(BytesIO(output))
    with pikepdf.open(BytesIO(output), password="secret") as pdf:
        assert float(pdf.pdf_version) >= 1.4
        assert len(pdf.pages) == 1
        image = next(iter(pdf.pages[0].Resources.XObject.values()))
        assert "/SMask" in image
