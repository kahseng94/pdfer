import json
from io import BytesIO
from zipfile import ZipFile

import pikepdf
import pytest
from conftest import make_pdf
from fastapi.testclient import TestClient

from pdfer import core
from pdfer.api import app


@pytest.fixture
def client():
    return TestClient(app)


def upload(data, name="private.pdf"):
    return name, data, "application/pdf"


def protected_widths(data, password):
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(BytesIO(data))
    with pikepdf.open(BytesIO(data), password=password) as pdf:
        assert pdf.is_encrypted
        return [int(page.mediabox[2]) for page in pdf.pages]


@pytest.mark.parametrize("password", ["correct horse", "  spaces stay  ", "密碼-é🔐", "x" * 127])
def test_protect_requires_the_password_and_uses_aes256(password):
    source = make_pdf([101, 202], rotations=[90, 0])
    output = core.protect(source, password)
    assert protected_widths(output, password) == [101, 202]
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(BytesIO(output), password="wrong")
    with pikepdf.open(BytesIO(output), password=password) as pdf:
        assert pdf.encryption.R == 6
        assert pdf.encryption.bits == 256
        assert pdf.pages[0].Rotate == 90
        assert pdf.user_password_matched
        assert not pdf.owner_password_matched
    with pikepdf.open(BytesIO(source)) as original:
        assert not original.is_encrypted


@pytest.mark.parametrize("password", ["", "bad\0password", "x" * 128, "é" * 64])
def test_rejects_passwords_that_could_be_empty_or_truncated(password):
    with pytest.raises(core.PdfToolError):
        core.protect(make_pdf([101]), password)


def test_unlock_preserves_content_metadata_and_geometry():
    with pikepdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(612, 792))
        page.Contents = pdf.make_stream(b"1 0 0 rg 20 20 80 80 re f")
        page.Rotate = 90
        page.CropBox = [10, 20, 600, 780]
        pdf.docinfo.Title = "Keep this title"
        original = BytesIO()
        pdf.save(original)
    locked = core.protect(original.getvalue(), "secret")
    with pytest.raises(core.PdfToolError, match="password-protected"):
        core.unlock(locked)
    with pytest.raises(core.PdfToolError, match="incorrect"):
        core.unlock(locked, password="wrong")
    unlocked = core.unlock(locked, password="secret")
    with pikepdf.open(BytesIO(unlocked)) as pdf:
        assert not pdf.is_encrypted
        assert "/Encrypt" not in pdf.trailer
        assert pdf.docinfo.Title == "Keep this title"
        assert pdf.pages[0].Contents.read_bytes() == b"1 0 0 rg 20 20 80 80 re f"
        assert list(pdf.pages[0].CropBox) == [10, 20, 600, 780]
        assert pdf.pages[0].Rotate == 90


def test_protect_can_change_an_existing_password():
    source = make_pdf([101], password="old")
    output = core.protect(source, "new", password="old")
    assert protected_widths(output, "new") == [101]
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(BytesIO(output), password="old")


@pytest.mark.parametrize("order", [(0, 1, 2), (2, 0, 1)])
def test_merge_uses_first_protected_file_password(order):
    files = [("plain.pdf", make_pdf([100])), ("a.pdf", make_pdf([200], password="alpha")), ("b.pdf", make_pdf([300], password="beta"))]
    passwords = ["", "alpha", "beta"]
    arranged = [files[i] for i in order]
    ordered_passwords = [passwords[i] for i in order]
    first = next(password for password in ordered_passwords if password)
    output = core.merge(arranged, ordered_passwords)
    assert protected_widths(output, first) == [(i + 1) * 100 for i in order]


@pytest.mark.parametrize("endpoint, fields", [
    ("split", {"mode": "extract", "ranges": "2,1"}),
    ("organize", {"pages": "2:90,1"}),
    ("edit", {"edits": json.dumps([{"type": "text", "page": 1, "x": 10, "y": 10, "text": "Added text", "size": 12, "color": "#000000"}])}),
    ("compress", {"level": "light"}),
])
def test_existing_pdf_operations_accept_passwords_and_keep_protection(client, endpoint, fields):
    source = make_pdf([101, 202], password="secret")
    response = client.post(f"/api/{endpoint}", files={"file": upload(source)}, data={**fields, "password": "secret"})
    assert response.status_code == 200, response.text[:200]
    assert protected_widths(response.content, "secret") == ([202, 101] if endpoint in ("split", "organize") else [101, 202])
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("mode", ["ranges", "each"])
def test_every_pdf_inside_a_split_zip_stays_protected(client, mode):
    response = client.post("/api/split", files={"file": upload(make_pdf([101, 202], password="secret"))},
                           data={"mode": mode, "ranges": "1,2", "password": "secret"})
    assert response.status_code == 200
    with ZipFile(BytesIO(response.content)) as archive:
        assert [protected_widths(archive.read(name), "secret") for name in archive.namelist()] == [[101], [202]]


def test_compression_keeps_protection_even_when_images_are_rewritten(image_pdf):
    source = core.protect(image_pdf, "secret")
    output = core.compress(source, "strong", password="secret")
    assert len(output) < len(source)
    assert protected_widths(output, "secret") == [612]


@pytest.mark.parametrize("endpoint, fields", [
    ("split", {"mode": "extract", "ranges": "1"}),
    ("organize", {"pages": "1"}),
    ("edit", {"edits": "[]"}),
    ("compress", {"level": "light"}),
    ("unlock", {}),
    ("protect", {"new_password": "replacement"}),
])
def test_wrong_passwords_return_useful_errors_without_echoing_secrets(client, endpoint, fields):
    response = client.post(f"/api/{endpoint}", files={"file": upload(make_pdf([101], password="secret"))},
                           data={**fields, "password": "dont-echo-this-password"})
    assert response.status_code == 400
    assert "incorrect" in response.json()["detail"]
    assert "dont-echo-this-password" not in response.text
    assert "replacement" not in response.text


def test_protect_unlock_api_roundtrip(client):
    response = client.post("/api/protect", files={"file": upload(make_pdf([101, 202]), "résumé.pdf")}, data={"new_password": "test secret"})
    assert response.status_code == 200
    assert "_protected.pdf" in response.headers["content-disposition"]
    assert protected_widths(response.content, "test secret") == [101, 202]
    unlocked = client.post("/api/unlock", files={"file": upload(response.content)}, data={"password": "test secret"})
    assert unlocked.status_code == 200
    assert "_unlocked.pdf" in unlocked.headers["content-disposition"]
    with pikepdf.open(BytesIO(unlocked.content)) as pdf:
        assert not pdf.is_encrypted
        assert len(pdf.pages) == 2


def test_merge_api_accepts_different_passwords(client):
    response = client.post("/api/merge", files=[("files", upload(make_pdf([101], password="one"))), ("files", upload(make_pdf([202], password="two")))],
                           data={"passwords": json.dumps(["one", "two"])})
    assert response.status_code == 200
    assert protected_widths(response.content, "one") == [101, 202]


@pytest.mark.parametrize("passwords", ['not-json', 'null', '{}', '[]', '["a"]', '["a", 2]'])
def test_merge_rejects_malformed_password_lists(client, passwords):
    response = client.post("/api/merge", files=[("files", upload(make_pdf([101]))), ("files", upload(make_pdf([202])))], data={"passwords": passwords})
    assert response.status_code == 400


def test_new_password_length_validation_does_not_echo_the_password(client):
    secret = "é" * 64
    response = client.post("/api/protect", files={"file": upload(make_pdf([101]))}, data={"new_password": secret})
    assert response.status_code == 400
    assert "127" in response.json()["detail"]
    assert secret not in response.text
