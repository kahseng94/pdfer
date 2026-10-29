import json
from io import BytesIO

import pikepdf
import pytest
from fastapi.testclient import TestClient

from pdfer import core, forms
from pdfer.api import app


def form_pdf(password=""):
    with pikepdf.new() as pdf:
        pages = [pdf.add_blank_page(page_size=(612, 792)) for _ in range(2)]
        for page in pages: page.Annots = pikepdf.Array()
        fields = []
        font = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
        def appearance(on=False):
            return pdf.make_stream(b"0.9 g 0 0 20 20 re f " + (b"0 g 3 3 14 14 re f" if on else b""), Type=pikepdf.Name.XObject, Subtype=pikepdf.Name.Form, BBox=[0, 0, 20, 20], Resources=pikepdf.Dictionary())
        def widget(page=0, rect=(30, 650, 300, 680), **values):
            obj = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget, Rect=list(rect), P=pages[page].obj, **values))
            pages[page].Annots.append(obj)
            return obj
        shared = pdf.make_indirect(pikepdf.Dictionary(FT=pikepdf.Name.Tx, T="name", V="Before", MaxLen=40, Kids=pikepdf.Array()))
        for index in range(2): shared.Kids.append(widget(page=index, Parent=shared))
        fields.append(shared)
        fields.append(widget(rect=(30, 520, 300, 620), FT=pikepdf.Name.Tx, T="notes", V="Original note", Ff=1 << 12))
        fields.append(widget(rect=(30, 450, 300, 480), FT=pikepdf.Name.Ch, T="country", V="ca", Ff=1 << 17, Opt=pikepdf.Array([pikepdf.Array(["ca", "Canada"]), pikepdf.Array(["fr", "France"])])))
        fields.append(widget(rect=(30, 400, 50, 420), FT=pikepdf.Name.Btn, T="consent", V=pikepdf.Name.Off, AS=pikepdf.Name.Off, AP=pikepdf.Dictionary(N=pikepdf.Dictionary(Off=appearance(), Yes=appearance(True)))))
        radio = pdf.make_indirect(pikepdf.Dictionary(FT=pikepdf.Name.Btn, T="plan", Ff=1 << 15, V=pikepdf.Name.beta, Kids=pikepdf.Array()))
        for i, value in enumerate(("alpha", "beta")):
            states = pikepdf.Dictionary(Off=appearance()); states["/" + value] = appearance(True)
            radio.Kids.append(widget(rect=(100 + i * 40, 400, 120 + i * 40, 420), Parent=radio, AS=pikepdf.Name("/" + value) if value == "beta" else pikepdf.Name.Off, AP=pikepdf.Dictionary(N=states)))
        fields.append(radio)
        fields.append(widget(rect=(30, 330, 300, 360), FT=pikepdf.Name.Tx, T="readonly", V="Read only", Ff=1))
        link = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Link, Rect=[30, 280, 130, 300], A=pikepdf.Dictionary(S=pikepdf.Name.URI, URI="https://example.com")))
        pages[0].Annots.append(link)
        pdf.Root.AcroForm = pikepdf.Dictionary(Fields=pikepdf.Array(fields), DA=pikepdf.String("/Helv 12 Tf 0 g"), DR=pikepdf.Dictionary(Font=pikepdf.Dictionary(Helv=font)))
        return core._save(pdf, password)


def values_for(source, values, password=""):
    return {field["id"]: values[field["name"]] for field in forms.read(source, password=password)["fields"] if field["name"] in values}


def test_fill_keeps_values_canonical_and_updates_every_widget():
    source = form_pdf()
    wanted = {"name": "Zoë Δοκιμή", "notes": "First line\nSecond line", "country": "fr", "consent": True, "plan": "alpha"}
    result = forms.fill(source, json.dumps(values_for(source, wanted)))
    fields = {field["name"]: field for field in forms.read(result)["fields"]}
    assert {key: fields[key]["value"] for key in wanted} == wanted
    with pikepdf.open(BytesIO(result)) as pdf:
        assert len(pdf.pages) == 2
        assert not pdf.Root.AcroForm.NeedAppearances
        assert not pdf.check_pdf_syntax()
        for page in pdf.pages:
            shared = next(widget for widget in page.Annots if widget.get("/Parent", {}).get("/T") == "name")
            assert shared.Parent.V == "Zoë Δοκιμή"
            assert shared.AP.N.read_bytes()
            assert shared.AP.N.Resources.Font
        assert fields["readonly"]["value"] == "Read only"
        consent = next(field for field in pdf.Root.AcroForm.Fields if field.get("/T") == "consent")
        assert consent.V == consent.AS == pikepdf.Name.Yes
        radio = next(field for field in pdf.Root.AcroForm.Fields if field.get("/T") == "plan")
        assert radio.V == pikepdf.Name.alpha
        assert [widget.AS for widget in radio.Kids] == [pikepdf.Name.alpha, pikepdf.Name.Off]


def test_flatten_removes_widgets_and_field_tree_but_keeps_other_annotations():
    source = form_pdf()
    result = forms.fill(source, json.dumps(values_for(source, {"name": "Ada", "consent": True})), True)
    with pikepdf.open(BytesIO(result)) as pdf:
        assert len(pdf.pages) == 2
        assert "/AcroForm" not in pdf.Root
        assert all(annot.Subtype != pikepdf.Name.Widget for page in pdf.pages for annot in page.get("/Annots", []))
        assert pdf.pages[0].Annots[0].A.URI == "https://example.com"
        assert pdf.pages[0].Resources.XObject


def test_preserves_password_and_readonly_fields_are_rejected():
    source = form_pdf("secret")
    result = forms.fill(source, json.dumps(values_for(source, {"name": "Ada"}, "secret")), password="secret")
    with pytest.raises(pikepdf.PasswordError): pikepdf.open(BytesIO(result))
    assert forms.read(result, password="secret")["pages"] == 2
    with pytest.raises(core.PdfToolError, match="read-only"):
        forms.fill(source, json.dumps(values_for(source, {"readonly": "Changed"}, "secret")), password="secret")


@pytest.mark.parametrize("values", [{"name": "x" * 41}, {"name": "two\nlines"}, {"consent": "true"}, {"country": "invalid"}, {"plan": "unknown"}])
def test_invalid_values_do_not_silently_truncate_or_change_type(values):
    source = form_pdf()
    with pytest.raises(core.PdfToolError): forms.fill(source, json.dumps(values_for(source, values)))


def test_rejects_orphan_widgets_xfa_and_unknown_ids():
    source = form_pdf()
    with pytest.raises(core.PdfToolError, match="could not be found"): forms.fill(source, '{"missing":"x"}')
    with pikepdf.open(BytesIO(source)) as pdf:
        ghost = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget, FT=pikepdf.Name.Tx, T="ghost", Rect=[0, 0, 100, 30]))
        pdf.pages[0].Annots.append(ghost)
        with pytest.warns(pikepdf.PageCopyWarning): broken = core._save(pdf)
        with pytest.raises(core.PdfToolError, match="missing from its field tree"): forms.read(broken)
    with pikepdf.open(BytesIO(source)) as pdf:
        pdf.Root.AcroForm.XFA = pdf.make_stream(b"<xfa/>")
        with pytest.raises(core.PdfToolError, match="XFA"): forms.read(core._save(pdf))


def test_existing_digital_signature_prevents_mutation():
    with pikepdf.open(BytesIO(form_pdf())) as pdf:
        signature = pdf.make_indirect(pikepdf.Dictionary(FT=pikepdf.Name.Sig, T="signature", V=pikepdf.Dictionary(Type=pikepdf.Name.Sig, ByteRange=[0, 1, 2, 3])))
        pdf.Root.AcroForm.Fields.append(signature)
        data = core._save(pdf)
    assert forms.read(data)["signed"]
    with pytest.raises(core.PdfToolError, match="digital signature"): forms.fill(data, '{}')


def test_api_form_read_and_fill():
    client = TestClient(app)
    source = form_pdf()
    response = client.post('/api/forms/read', files={'file': ('form.pdf', source, 'application/pdf')})
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    result = client.post('/api/forms/fill', files={'file': ('form.pdf', source, 'application/pdf')}, data={'values': json.dumps(values_for(source, {'name': 'Ada'}))})
    assert result.status_code == 200
    assert 'form_filled.pdf' in result.headers['content-disposition']
    assert next(field for field in forms.read(result.content)['fields'] if field['name'] == 'name')['value'] == 'Ada'


def test_existing_multiline_carriage_returns_render_as_lines_without_changing_the_value():
    with pikepdf.open(BytesIO(form_pdf())) as pdf:
        field = next(field for field in pdf.Root.AcroForm.Fields if field.get('/T') == 'notes')
        field.V = 'First\rSecond'
        source = core._save(pdf)
    result = forms.fill(source, json.dumps(values_for(source, {'name': 'Ada'})))
    with pikepdf.open(BytesIO(result)) as pdf:
        field = next(field for field in pdf.Root.AcroForm.Fields if field.get('/T') == 'notes')
        assert field.V == 'First\rSecond'
        assert sum(str(operator) == 'Tj' for _, operator in pikepdf.parse_content_stream(field.AP.N)) == 2
