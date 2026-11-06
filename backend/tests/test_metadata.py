import json
from io import BytesIO
from xml.etree import ElementTree as ET

import pikepdf
import pypdfium2 as pdfium
import pytest
from fastapi.testclient import TestClient

from conftest import make_image_pdf, make_pdf
from pdfer import core, metadata
from pdfer.api import app


def save(pdf, password=""):
    output = BytesIO()
    pdf.save(output, encryption=core._encryption(password), fix_metadata_version=False)
    return output.getvalue()


def document(password=""):
    with pikepdf.open(BytesIO(make_image_pdf(side=20))) as pdf:
        page = pdf.pages[0]
        pdf.add_blank_page(page_size=(400, 300))
        font = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
        page.Resources.Font = pikepdf.Dictionary(F1=font)
        page.Contents = pdf.make_stream(page.Contents.read_bytes() + b"\nBT /F1 18 Tf 30 700 Td (Selectable text remains) Tj ET")
        widget = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget, FT=pikepdf.Name.Tx, T="name", V="Original form value", Rect=[30, 600, 200, 620], P=page.obj,
                                                   AP=pikepdf.Dictionary(N=pdf.make_stream(b"0 g 0 0 10 10 re f", Type=pikepdf.Name.XObject, Subtype=pikepdf.Name.Form, BBox=[0, 0, 170, 20], Resources=pikepdf.Dictionary()))))
        comment = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Text, Rect=[30, 500, 50, 520], Contents="Private comment", T="Comment author"))
        page.Annots = pikepdf.Array([widget, comment])
        pdf.Root.AcroForm = pikepdf.Dictionary(Fields=pikepdf.Array([widget]), DA="/F1 12 Tf", DR=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font)))
        with pdf.open_outline() as outline:
            outline.root = [pikepdf.OutlineItem("Chapter", 0), pikepdf.OutlineItem("Second", 1)]
        pdf.attachments["note.txt"] = b"Attachment deliberately preserved"
        page.Metadata = pdf.make_stream(b"Page metadata deliberately preserved", Type=pikepdf.Name.Metadata, Subtype=pikepdf.Name.XML)
        with pdf.open_metadata(set_pikepdf_as_editor=False) as meta:
            meta["dc:title"] = "XMP title"
            meta["dc:creator"] = ["Ada", "Zoë"]
            meta["dc:description"] = "XMP subject"
            meta["pdf:Keywords"] = "invoice, original"
            meta["dc:subject"] = {"separate", "tags"}
            meta["xmp:CreatorTool"] = "Original creator"
            meta["pdf:Producer"] = "Original producer"
            meta["xmp:CreateDate"] = "2025-02-03T04:05:06-08:00"
            meta["xmp:ModifyDate"] = "2025-03-04"
            meta["xmp:MetadataDate"] = "2025-03-04T00:00:00Z"
            meta["{https://example.com/custom/}Private"] = "Custom XMP"
        pdf.docinfo.Title = "Legacy title differs"
        pdf.docinfo.Subject = "Legacy subject differs"
        pdf.docinfo.Creator = "Legacy creator differs"
        pdf.docinfo.CreationDate = "D:2020"  # Deliberately different and reduced precision.
        pdf.docinfo.Custom = "Custom legacy value"
        return save(pdf, password)


def edit(source, changes, **kwargs):
    return metadata.write(source, json.dumps(changes), **kwargs)


def with_xmp(fragment):
    packet = f'''<x:xmpmeta xmlns:x="adobe:ns:meta/">
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:custom="https://example.com/custom/">
        {fragment}
    </rdf:Description></rdf:RDF></x:xmpmeta>'''.encode()
    with pikepdf.open(BytesIO(make_pdf([200]))) as pdf:
        pdf.Root.Metadata = pdf.make_stream(packet, Type=pikepdf.Name.Metadata, Subtype=pikepdf.Name.XML)
        return save(pdf)


@pytest.mark.parametrize("clear", [False, True])
@pytest.mark.parametrize("revision", [4, 6])
@pytest.mark.parametrize("user_password,opening", [("reader", "reader"), ("reader", "owner"), ("", ""), ("", "owner")])
def test_preserves_both_passwords_permissions_and_encryption_settings(clear, revision, user_password, opening):
    with pikepdf.open(BytesIO(document())) as pdf:
        output = BytesIO()
        pdf.save(output, encryption=pikepdf.Encryption(user=user_password, owner="owner", R=revision, metadata=False,
                 allow=pikepdf.Permissions(extract=False, modify_annotation=False, print_highres=False)), fix_metadata_version=False)
        source = output.getvalue()
    result = edit(source, {} if clear else {"title": "Revised"}, clear=clear, password=opening)
    for password in (user_password, "owner"):
        with pikepdf.open(BytesIO(source), password=password) as before, pikepdf.open(BytesIO(result), password=password) as after:
            assert after.is_encrypted
            assert after.owner_password_matched == before.owner_password_matched
            assert after.user_password_matched == before.user_password_matched
            assert after.allow == before.allow
            assert after.trailer.Encrypt == before.trailer.Encrypt
            assert fingerprint(after.Root) == fingerprint(before.Root)
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(BytesIO(result), password="wrong")


@pytest.mark.parametrize("changes", [{"title": "New metadata title"}, {"title": None}])
def test_documentinfo_edits_do_not_mutate_shared_bookmark_objects(changes):
    with pikepdf.open(BytesIO(document())) as pdf:
        pdf.docinfo = pdf.Root.Outlines.First
        source = save(pdf)
    result = edit(source, changes)
    with pikepdf.open(BytesIO(source)) as before, pikepdf.open(BytesIO(result)) as after:
        assert fingerprint(after.Root) == fingerprint(before.Root)
        assert after.docinfo.objgen != after.Root.Outlines.First.objgen
        assert after.Root.Outlines.First.Title == "Chapter"


@pytest.mark.parametrize("fragment", [
    '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Old</rdf:li><rdf:li xml:lang="x-default">Stale</rdf:li></rdf:Alt></dc:title>',
    '<dc:description><rdf:Alt><rdf:li>Missing language</rdf:li></rdf:Alt></dc:description>',
    '<pdf:Keywords rdf:resource="urn:original"/>',
    '<pdf:Keywords rdf:parseType="Resource"><rdf:value>Old</rdf:value><custom:note>Qualifier</custom:note></pdf:Keywords>',
    '<dc:title><rdf:Alt><rdf:li xml:lang="X-DEFAULT">Old</rdf:li></rdf:Alt></dc:title>',
    '<dc:title rdf:resource="urn:original"><rdf:Alt><rdf:li xml:lang="x-default">Old</rdf:li></rdf:Alt></dc:title>',
    '<dc:creator><rdf:Seq><rdf:li rdf:resource="urn:author"/></rdf:Seq></dc:creator>',
    '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Old</rdf:li></rdf:Alt><custom:note>Hidden structure</custom:note></dc:title>',
])
def test_unsupported_xmp_is_flagged_before_editing_and_remains_clearable(fragment):
    source = with_xmp(fragment)
    schema = metadata.read(source)
    assert not schema["canEdit"] and schema["warnings"]
    assert not schema["fields"]["title"]["xmpReadable"]
    assert edit(source, {}) == source
    with pytest.raises(core.PdfToolError, match="malformed or unsupported"):
        edit(source, {"title": "Revised"})
    assert not metadata.read(metadata.write(source, clear=True))["hasXmp"]


def test_empty_xmp_values_are_present_and_do_not_disable_editing():
    source = with_xmp('<dc:title><rdf:Alt><rdf:li xml:lang="x-default"/></rdf:Alt></dc:title><dc:creator><rdf:Seq><rdf:li/></rdf:Seq></dc:creator>')
    schema = metadata.read(source)
    assert schema["canEdit"]
    for key in ("title", "author"):
        assert schema["fields"][key]["xmp"] == ""
        assert schema["fields"][key]["documentInfo"] is None
    result = edit(source, {"keywords": "new"})
    for key in ("title", "author"):
        assert metadata.read(result)["fields"][key] == schema["fields"][key]


def test_repeated_properties_sync_and_language_variants_follow_pikepdf_semantics():
    source = with_xmp('<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Menu</rdf:li><rdf:li xml:lang="fr">Menu</rdf:li><rdf:li xml:lang="ja">メニュー</rdf:li></rdf:Alt></dc:title><dc:title>Stale duplicate</dc:title>')
    result = edit(source, {"title": "Revised"})
    with pikepdf.open(BytesIO(result)) as pdf:
        tree = ET.fromstring(pdf.Root.Metadata.read_bytes())
        titles = list(tree.iter('{http://purl.org/dc/elements/1.1/}title'))
        assert len(titles) == 1
        items = {item.get('{http://www.w3.org/XML/1998/namespace}lang'): item.text for item in titles[0][0]}
        assert items == {"x-default": "Revised", "fr": "Revised", "ja": "メニュー"}
        assert pdf.docinfo.Title == "Revised"
    cleared = edit(source, {"title": None})
    with pikepdf.open(BytesIO(cleared)) as pdf:
        assert b"Stale duplicate" not in pdf.Root.Metadata.read_bytes()
        assert "dc:title" not in pdf.open_metadata()
        assert "/Title" not in pdf.docinfo


def test_reads_both_stores_conflicts_authors_and_readonly_dates():
    result = metadata.read(document())
    assert result["canEdit"] and not result["warnings"]
    assert result["hasXmp"] and result["hasDocumentInfo"]
    assert result["fields"]["title"] == {"xmp": "XMP title", "documentInfo": "Legacy title differs", "value": "XMP title", "conflict": True, "xmpReadable": True, "documentInfoReadable": True}
    assert result["fields"]["author"]["value"] == "Ada; Zoë"
    assert result["fields"]["created"]["documentInfo"] == "D:2020"


def test_unicode_edits_sync_all_four_fields_without_touching_unrelated_metadata():
    source = document()
    changes = {key: f"{key}: Café 日本語 العربية 🐕\nSecond line" for key in metadata.FIELDS}
    result = edit(source, changes)
    with pikepdf.open(BytesIO(source)) as before, pikepdf.open(BytesIO(result)) as after:
        old, new = before.open_metadata(), after.open_metadata()
        for field, (xmp_key, info_key) in metadata.FIELDS.items():
            assert str(after.docinfo[info_key]) == changes[field]
            assert new[xmp_key] == ([changes[field]] if field == "author" else changes[field])
        for key in ["dc:subject", "{https://example.com/custom/}Private", *[pair[0] for pair in metadata.READ_ONLY.values()]]:
            assert new[key] == old[key]
        for key in before.docinfo:
            if key not in {pair[1] for pair in metadata.FIELDS.values()}:
                assert after.docinfo[key] == before.docinfo[key]
        assert not after.check_pdf_syntax()
    assert metadata.read(source)["fields"]["title"]["conflict"]  # Input bytes unchanged.


def test_keep_is_a_true_noop_and_explicit_clear_is_distinct():
    source = document()
    assert edit(source, {}) is source
    result = edit(source, {"title": None})
    values = metadata.read(result)["fields"]
    assert values["title"]["xmp"] is None and values["title"]["documentInfo"] is None
    assert values["subject"] == metadata.read(source)["fields"]["subject"]
    # Explicitly applying the already displayed XMP value reconciles a conflict.
    result = edit(source, {"title": "XMP title"})
    assert not metadata.read(result)["fields"]["title"]["conflict"]


def test_absent_and_legacy_only_metadata():
    source = make_pdf([200])
    assert all(item["value"] is None for item in metadata.read(source)["fields"].values())
    assert not metadata.read(source)["hasDocumentInfo"]
    result = edit(source, {"title": "New"})
    assert metadata.read(result)["fields"]["title"]["documentInfo"] == "New"
    with pikepdf.open(BytesIO(source)) as pdf:
        pdf.docinfo.Author = "Legacy author"
        pdf.docinfo.Subject = "Keep legacy-only subject"
        pdf.docinfo.ModDate = "invalid date preserved verbatim"
        legacy = save(pdf)
    result = edit(legacy, {"author": "New author"})
    with pikepdf.open(BytesIO(result)) as pdf:
        assert pdf.docinfo.Subject == "Keep legacy-only subject"
        assert pdf.docinfo.ModDate == "invalid date preserved verbatim"
        assert "dc:description" not in pdf.open_metadata()


def test_clear_removes_entire_document_stores_including_custom_fields_and_dates():
    result = metadata.write(document(), clear=True)
    with pikepdf.open(BytesIO(result)) as pdf:
        assert "/Metadata" not in pdf.Root
        assert "/Info" not in pdf.trailer
        assert pdf.pages[0].Metadata.read_bytes() == b"Page metadata deliberately preserved"
        assert pdf.pages[0].Annots[1].Contents == "Private comment"
        assert pdf.attachments["note.txt"].get_file().read_bytes() == b"Attachment deliberately preserved"
    schema = metadata.read(result)
    assert not schema["hasXmp"] and not schema["hasDocumentInfo"]
    assert all(item["value"] is None for item in schema["fields"].values())
    assert metadata.read(metadata.write(make_pdf([200]), clear=True))["canEdit"]


def fingerprint(root):
    """Compare the complete content graph, including reference relationships."""
    seen = {}
    def walk(obj):
        if isinstance(obj, pikepdf.Object) and obj.is_indirect:
            if obj.objgen in seen:
                return ("reference", seen[obj.objgen])
            seen[obj.objgen] = len(seen)
        if isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)):
            ignored = {"/Length", "/Filter", "/DecodeParms"} if isinstance(obj, pikepdf.Stream) else set()
            items = [(key, walk(obj[key])) for key in sorted(obj.keys()) if key not in ignored and not (obj is root and key == "/Metadata")]
            return (items, obj.read_bytes()) if isinstance(obj, pikepdf.Stream) else items
        if isinstance(obj, pikepdf.Array):
            return [walk(item) for item in obj]
        return str(obj)
    return walk(root)


@pytest.mark.parametrize("clear", [False, True])
def test_preserves_content_graph_rendering_selectable_text_and_password(clear):
    source = document("secret")
    result = edit(source, {} if clear else {"title": "Revised"}, clear=clear, password="secret")
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(BytesIO(result))
    with pikepdf.open(BytesIO(source), password="secret") as before, pikepdf.open(BytesIO(result), password="secret") as after:
        assert fingerprint(before.Root) == fingerprint(after.Root)
        assert len(after.pages) == 2
        assert after.Root.AcroForm.Fields[0].V == "Original form value"
        assert [item.title for item in after.open_outline().root] == ["Chapter", "Second"]
    with pdfium.PdfDocument(source, password="secret") as before, pdfium.PdfDocument(result, password="secret") as after:
        for index in range(len(before)):
            old, new = before[index], after[index]
            try:
                old_text, new_text = old.get_textpage(), new.get_textpage()
                try:
                    assert old_text.get_text_range() == new_text.get_text_range()
                    if index == 0:
                        assert "Selectable text remains" in new_text.get_text_range()
                finally:
                    old_text.close(); new_text.close()
                old_bitmap, new_bitmap = old.render(), new.render()
                try:
                    assert old_bitmap.to_pil().tobytes() == new_bitmap.to_pil().tobytes()
                finally:
                    old_bitmap.close(); new_bitmap.close()
            finally:
                old.close(); new.close()


@pytest.mark.parametrize("xmp", [b"<broken", b"<not-xmp/>", b"", b"\x00invalid"])
def test_malformed_xmp_can_be_read_and_cleared_but_is_not_silently_repaired(xmp):
    with pikepdf.open(BytesIO(make_pdf([200]))) as pdf:
        pdf.Root.Metadata = pdf.make_stream(xmp, Type=pikepdf.Name.Metadata, Subtype=pikepdf.Name.XML)
        pdf.docinfo.Title = "Available legacy title"
        source = save(pdf)
    schema = metadata.read(source)
    assert not schema["canEdit"] and schema["warnings"]
    assert schema["fields"]["title"]["documentInfo"] == "Available legacy title"
    with pytest.raises(core.PdfToolError, match="malformed"):
        edit(source, {"title": "New"})
    assert edit(source, {}) == source
    assert not metadata.read(metadata.write(source, clear=True))["hasXmp"]


def test_malformed_metadata_objects_are_reported_and_clearable():
    with pikepdf.open(BytesIO(make_pdf([200]))) as pdf:
        pdf.Root.Metadata = pikepdf.String("not a stream")
        pdf.docinfo.Title = pikepdf.Array(["not", "a string"])
        source = save(pdf)
    assert not metadata.read(source)["canEdit"]
    assert metadata.read(metadata.write(source, clear=True))["canEdit"]


def test_language_alternatives_and_custom_structures_survive_targeted_edits():
    xmp = b'''<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:custom="https://example.com/custom/">
    <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Original</rdf:li><rdf:li xml:lang="fr">Titre</rdf:li></rdf:Alt></dc:title>
    <custom:structure rdf:parseType="Resource"><custom:child>Keep me</custom:child></custom:structure>
    </rdf:Description></rdf:RDF></x:xmpmeta>'''
    with pikepdf.open(BytesIO(make_pdf([200]))) as pdf:
        pdf.Root.Metadata = pdf.make_stream(xmp, Type=pikepdf.Name.Metadata, Subtype=pikepdf.Name.XML)
        source = save(pdf)
    result = edit(source, {"title": "Changed"})
    with pikepdf.open(BytesIO(result)) as pdf:
        raw = pdf.Root.Metadata.read_bytes()
        assert b'Titre' in raw and b'Keep me' in raw
        assert pdf.docinfo.Title == "Changed"
    cleared = edit(source, {"title": None})
    with pikepdf.open(BytesIO(cleared)) as pdf:
        assert b'Titre' not in pdf.Root.Metadata.read_bytes()
        assert b'Keep me' in pdf.Root.Metadata.read_bytes()


@pytest.mark.parametrize("changes", ['[]', 'null', '{', '{"producer":"changed"}', '{"title":1}', '{"title":false}', '{"title":""}', json.dumps({"title": "x" * 5001}), json.dumps({"title": "\x00"}), json.dumps({"title": "\ud800"})])
def test_invalid_edits_rejected(changes):
    with pytest.raises(core.PdfToolError):
        metadata.write(make_pdf([200]), changes)


def test_api_read_write_clear_password_errors_and_no_store():
    client = TestClient(app)
    source = document("secret")
    upload = {"file": ("source.pdf", source, "application/pdf")}
    assert client.post("/api/metadata/read", files=upload).status_code == 400
    assert client.post("/api/metadata", files=upload, data={"password": "wrong"}).status_code == 400
    read = client.post("/api/metadata/read", files=upload, data={"password": "secret"})
    assert read.status_code == 200 and read.json()["fields"]["title"]["conflict"]
    assert read.headers["cache-control"] == "no-store"
    output = client.post("/api/metadata", files=upload, data={"password": "secret", "changes": '{"title":"Revised","author":null}'})
    assert output.status_code == 200
    assert output.headers["content-type"] == "application/pdf"
    assert "source_metadata.pdf" in output.headers["content-disposition"]
    assert output.headers["cache-control"] == "no-store"
    assert metadata.read(output.content, password="secret")["fields"]["title"]["value"] == "Revised"
    cleared = client.post("/api/metadata", files=upload, data={"password": "secret", "clear": "true"})
    assert cleared.status_code == 200
    assert not metadata.read(cleared.content, password="secret")["hasXmp"]
    assert client.post("/api/metadata", files=upload, data={"clear": "true", "changes": '{"title":"New"}'}).status_code == 400
    assert client.post("/api/metadata/read", files={"file": ("invalid.pdf", b"invalid")}).status_code == 400
