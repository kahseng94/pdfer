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


def test_rejects_orphan_widgets_and_unknown_ids():
    source = form_pdf()
    with pytest.raises(core.PdfToolError, match="could not be found"): forms.fill(source, '{"missing":"x"}')
    with pikepdf.open(BytesIO(source)) as pdf:
        ghost = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget, FT=pikepdf.Name.Tx, T="ghost", Rect=[0, 0, 100, 30]))
        pdf.pages[0].Annots.append(ghost)
        with pytest.warns(pikepdf.PageCopyWarning): broken = core._save(pdf)
        with pytest.raises(core.PdfToolError, match="missing from its field tree"): forms.read(broken)


def hybrid_xfa_pdf(source=None, **root):
    with pikepdf.open(BytesIO(source or form_pdf())) as pdf:
        # XFA may be one stream or an array of packet names and streams.
        pdf.Root.AcroForm.XFA = pikepdf.Array(["template", pdf.make_stream(b"<template/>"), "datasets", pdf.make_stream(b"<xfa:datasets/>")])
        pdf.Root.Perms = pikepdf.Dictionary(UR3=pikepdf.Dictionary(Type=pikepdf.Name.Sig, Filter=pikepdf.Name("/Adobe.PPKLite")))
        for key, value in root.items(): pdf.Root[f"/{key}"] = value
        return core._save(pdf)


def test_hybrid_xfa_form_is_filled_through_its_acroform_fields():
    source = hybrid_xfa_pdf(NeedsRendering=False)
    schema = forms.read(source)
    assert schema["xfa"] and not schema["signed"]
    assert {field["name"] for field in schema["fields"]} >= {"name", "notes", "consent"}
    for flatten in (False, True):
        result = forms.fill(source, json.dumps(values_for(source, {"name": "Ada", "consent": True})), flatten)
        with pikepdf.open(BytesIO(result)) as pdf:
            assert "/XFA" not in pdf.Root.get("/AcroForm", {})
            assert "/NeedsRendering" not in pdf.Root and "/Perms" not in pdf.Root
            assert not pdf.check_pdf_syntax()
        if not flatten:
            filled = forms.read(result)
            assert not filled["xfa"]
            assert {field["name"]: field["value"] for field in filled["fields"]}["name"] == "Ada"
    assert not forms.read(form_pdf())["xfa"]


def test_dynamic_xfa_forms_are_rejected():
    with pytest.raises(core.PdfToolError, match="dynamic XFA"): forms.read(hybrid_xfa_pdf(NeedsRendering=True))
    with pikepdf.new() as pdf:
        pdf.add_blank_page()
        pdf.Root.AcroForm = pikepdf.Dictionary(Fields=pikepdf.Array(), XFA=pdf.make_stream(b"<xdp:xdp/>"))
        empty = core._save(pdf)
    with pytest.raises(core.PdfToolError, match="dynamic XFA"): forms.read(empty)
    with pytest.raises(core.PdfToolError, match="dynamic XFA"): forms.fill(empty, '{}')


def test_fill_drops_reader_usage_rights_but_keeps_other_permissions():
    with pikepdf.open(BytesIO(form_pdf())) as pdf:
        pdf.Root.Perms = pikepdf.Dictionary(UR3=pikepdf.Dictionary(Type=pikepdf.Name.Sig), Other=pikepdf.Name.Keep)
        source = core._save(pdf)
    with pikepdf.open(BytesIO(forms.fill(source, json.dumps(values_for(source, {"name": "Ada"}))))) as pdf:
        assert "/UR3" not in pdf.Root.Perms and pdf.Root.Perms.Other == pikepdf.Name.Keep


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


def blank_pdf(pages=1, password=""):
    with pikepdf.new() as pdf:
        for _ in range(pages): pdf.add_blank_page(page_size=(612, 792))
        return core._save(pdf, password)


def new_field(kind="text", name="Field", page=1, x=50, y=50, width=200, height=24, **extra):
    return {"type": kind, "name": name, "page": page, "x": x, "y": y, "width": width, "height": height, **extra}


EVERY_TYPE = [
    new_field("text", "Full name", label="Your full name", required=True, maxLength=40),
    new_field("text", "Notes", y=90, width=300, height=80, multiline=True),
    new_field("checkbox", "Agree", y=190, width=14, height=14),
    new_field("choice", "Country", y=220, width=150, height=22, options=["Canada", "France"], editable=True),
    new_field("radio", "Plan", y=260, width=14, height=14, option="Basic plan"),
    new_field("radio", "Plan", x=100, y=260, width=14, height=14, option="Pro", required=True),
]


def test_create_adds_each_field_type_that_fill_forms_can_then_fill():
    result = forms.create(blank_pdf(), json.dumps(EVERY_TYPE))
    fields = {field["name"]: field for field in forms.read(result)["fields"]}
    assert {name: field["type"] for name, field in fields.items()} == {"Full name": "text", "Notes": "text", "Agree": "checkbox", "Country": "choice", "Plan": "radio"}
    assert fields["Full name"].items() >= {"label": "Your full name", "required": True, "maxLength": 40, "multiline": False, "value": ""}.items()
    assert fields["Notes"]["multiline"] and fields["Country"]["editable"]
    assert [option["value"] for option in fields["Country"]["options"]] == ["Canada", "France"]
    assert [option["value"] for option in fields["Plan"]["options"]] == ["Basic plan", "Pro"]
    assert fields["Plan"]["required"] and not fields["Plan"]["allowEmpty"] and fields["Agree"]["value"] is False
    assert fields["Notes"]["boxes"] == [{"page": 1, "x": 50, "y": 90, "width": 300, "height": 80}]
    with pikepdf.open(BytesIO(result)) as pdf:
        assert not pdf.check_pdf_syntax()
        assert len(pdf.pages) == 1 and len(pdf.pages[0].Annots) == 6
        assert set(pdf.Root.AcroForm.DR.Font.keys()) == {"/Helv", "/ZaDb"} and pdf.Root.AcroForm.DA == "/Helv 0 Tf 0 g"
        for annot in pdf.pages[0].Annots:
            assert annot.Subtype == pikepdf.Name.Widget and annot.F == 4 and annot.P.objgen == pdf.pages[0].objgen
            assert isinstance(annot.AP.N, pikepdf.Stream) or set(annot.AP.N.keys()) >= {"/Off"}
    ids = {name: field["id"] for name, field in fields.items()}
    wanted = {"Full name": "Zoë", "Notes": "a\nb", "Agree": True, "Country": "Peru", "Plan": "Pro"}
    filled = forms.fill(result, json.dumps({ids[name]: value for name, value in wanted.items()}))
    assert {field["name"]: field["value"] for field in forms.read(filled)["fields"]} == wanted
    flat = forms.fill(result, json.dumps({ids["Agree"]: True}), True)
    with pikepdf.open(BytesIO(flat)) as pdf: assert "/AcroForm" not in pdf.Root and not pdf.pages[0].get("/Annots")


def test_create_keeps_existing_fields_values_and_resources():
    source = form_pdf()
    before = {field["name"]: field["value"] for field in forms.read(source)["fields"]}
    result = forms.create(source, json.dumps([new_field("text", "Email", page=2, y=700)]))
    after = {field["name"]: field for field in forms.read(result)["fields"]}
    assert {name: after[name]["value"] for name in before} == before
    assert after["Email"]["pages"] == [2]
    with pikepdf.open(BytesIO(source)) as original, pikepdf.open(BytesIO(result)) as pdf:
        assert pdf.Root.AcroForm.DR.Font.Helv.BaseFont == pikepdf.Name.Helvetica and "/ZaDb" in pdf.Root.AcroForm.DR.Font
        notes = next(field for field in pdf.Root.AcroForm.Fields if field.get("/T") == "notes")
        assert "/AP" not in notes and len(pdf.pages[0].Annots) == len(original.pages[0].Annots)


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("unit", [1, 2])
def test_create_places_fields_where_they_were_drawn_on_rotated_cropped_pages(rotation, unit):
    with pikepdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(400, 500))
        page.MediaBox, page.CropBox, page.Rotate, page.UserUnit = [-20, -30, 380, 470], [20, 30, 320, 430], rotation, unit
        source = core._save(pdf)
    box = {"x": 40, "y": 20, "width": 100, "height": 60}
    result = forms.create(source, json.dumps([new_field("text", "Name", **box)]))
    assert forms.read(result)["fields"][0]["boxes"] == [{"page": 1, **box}]
    with pikepdf.open(BytesIO(result)) as pdf:
        widget = pdf.pages[0].Annots[0]
        assert widget.MK.R == rotation
        if rotation == 90 and unit == 2:
            # Display (20, 260)-(70, 290) in the frame, rotated into the crop box at (320, 30).
            assert [float(v) for v in widget.Rect] == [30, 50, 60, 100]


def test_create_orders_new_fields_by_reading_position():
    spec = [new_field("text", "Bottom", y=500), new_field("text", "Right", x=300, y=100), new_field("text", "Left", x=50, y=100), new_field("text", "Page two", page=2)]
    result = forms.create(blank_pdf(2), json.dumps(spec))
    assert [field["name"] for field in forms.read(result)["fields"]] == ["Left", "Right", "Bottom", "Page two"]


@pytest.mark.parametrize(("spec", "message"), [
    ("not json", "valid JSON"),
    ("[]", "1 to 500"),
    (json.dumps([new_field("signature")]), '"type" must be one of'),
    (json.dumps([new_field(name=" ")]), "name must be 1–100"),
    (json.dumps([new_field(name="a.b")]), 'cannot contain "."'),
    (json.dumps([new_field(name="tab\there")]), "control characters"),
    (json.dumps([new_field(page=2)]), "outside pages"),
    (json.dumps([new_field(x=500)]), "fit inside page 1"),
    (json.dumps([new_field(width=7)]), "at least 8 points"),
    (json.dumps([new_field(maxLength=0)]), "maximum length"),
    (json.dumps([new_field("choice", options=[])]), "1 to 100 options"),
    (json.dumps([new_field("choice", options=["A", "A"])]), "different from each other"),
    (json.dumps([new_field("radio", option="A")]), "at least 2 buttons"),
    (json.dumps([new_field("radio", option="A"), new_field("radio", option="A", y=100)]), "same option"),
    (json.dumps([new_field("radio", option="Off"), new_field("radio", option="On", y=100)]), "reserved"),
    (json.dumps([new_field(), new_field(y=100)]), "already named"),
    (json.dumps([new_field("radio", option="A"), new_field("radio", option="B", y=100), new_field(y=150)]), "already named"),
])
def test_create_rejects_invalid_fields(spec, message):
    with pytest.raises(core.PdfToolError, match=message): forms.create(blank_pdf(), spec)


def test_create_rejects_names_already_in_the_pdf_and_too_many_fields():
    source = form_pdf()
    with pytest.raises(core.PdfToolError, match='already has a field named "notes"'): forms.create(source, json.dumps([new_field(name="notes")]))
    with pytest.raises(core.PdfToolError, match="at most 500 fields"):
        forms.create(source, json.dumps([new_field("checkbox", f"Box {i}", width=10, height=10) for i in range(495)]))


def test_create_refuses_signed_pdfs_drops_xfa_and_keeps_the_password():
    with pikepdf.open(BytesIO(form_pdf())) as pdf:
        pdf.Root.AcroForm.Fields.append(pdf.make_indirect(pikepdf.Dictionary(FT=pikepdf.Name.Sig, T="signature", V=pikepdf.Dictionary(Type=pikepdf.Name.Sig))))
        signed = core._save(pdf)
    with pytest.raises(core.PdfToolError, match="digital signature"): forms.create(signed, json.dumps([new_field()]))
    with pikepdf.open(BytesIO(forms.create(hybrid_xfa_pdf(NeedsRendering=False), json.dumps([new_field(name="Email")])))) as pdf:
        assert "/XFA" not in pdf.Root.AcroForm and "/Perms" not in pdf.Root
    protected = forms.create(blank_pdf(password="secret"), json.dumps([new_field()]), password="secret")
    with pytest.raises(pikepdf.PasswordError): pikepdf.open(BytesIO(protected))
    assert forms.read(protected, password="secret")["fields"][0]["name"] == "Field"


def test_api_form_create():
    response = TestClient(app).post('/api/forms/create', files={'file': ('flat.pdf', blank_pdf(), 'application/pdf')}, data={'fields': json.dumps(EVERY_TYPE)})
    assert response.status_code == 200
    assert 'flat_form.pdf' in response.headers['content-disposition']
    assert len(forms.read(response.content)['fields']) == 5
    bad = TestClient(app).post('/api/forms/create', files={'file': ('flat.pdf', blank_pdf(), 'application/pdf')}, data={'fields': '[]'})
    assert bad.status_code == 400 and "1 to 500" in bad.json()['detail']


def test_read_reports_where_each_widget_is_and_which_option_it_turns_on():
    fields = {field["name"]: field for field in forms.read(form_pdf())["fields"]}
    assert fields["name"]["boxes"] == [{"page": 1, "x": 30, "y": 112, "width": 270, "height": 30}, {"page": 2, "x": 30, "y": 112, "width": 270, "height": 30}]
    assert [box["option"] for box in fields["plan"]["boxes"]] == ["alpha", "beta"]
    assert fields["consent"]["boxes"] == [{"page": 1, "x": 30, "y": 372, "width": 20, "height": 20, "option": "Yes"}]
    assert "option" not in fields["country"]["boxes"][0]


def ids_for(source, names):
    return [field["id"] for field in forms.read(source)["fields"] if field["name"] in names]


def test_create_removes_fields_with_all_their_widgets_and_frees_their_names():
    source = form_pdf()
    assert {field["name"] for field in forms.read(source)["fields"]} == {"name", "notes", "country", "consent", "plan", "readonly"}
    remove = ids_for(source, ["name", "plan", "notes"])
    result = forms.create(source, json.dumps([new_field("text", "notes", y=700)]), remove=json.dumps(remove))
    after = {field["name"]: field for field in forms.read(result)["fields"]}
    assert set(after) == {"notes", "country", "consent", "readonly"}
    assert after["notes"]["value"] == "" and after["notes"]["boxes"] == [{"page": 1, "x": 50, "y": 700, "width": 200, "height": 24}]
    assert after["country"]["value"] == "ca" and after["consent"]["value"] is False and after["readonly"]["value"] == "Read only"
    with pikepdf.open(BytesIO(source)) as original, pikepdf.open(BytesIO(result)) as pdf:
        assert not pdf.check_pdf_syntax()
        # Both widgets of the two-page "name" field, both radio buttons and the old notes box are gone; the link stays.
        assert len(pdf.pages[0].Annots) == len(original.pages[0].Annots) - 4 + 1
        assert [str(annot.Subtype) for annot in pdf.pages[0].Annots].count("/Link") == 1
        assert len(pdf.pages[1].Annots) == 0
        assert {str(field.T) for field in pdf.Root.AcroForm.Fields} == {"notes", "country", "consent", "readonly"}


def test_create_can_only_remove_and_drops_a_form_left_without_fields():
    source = form_pdf()
    everything = [field["id"] for field in forms.read(source)["fields"]]
    result = forms.create(source, "[]", remove=json.dumps(everything))
    assert forms.read(result)["fields"] == []
    with pikepdf.open(BytesIO(result)) as pdf:
        assert "/AcroForm" not in pdf.Root
        assert [str(annot.Subtype) for annot in pdf.pages[0].Annots] == ["/Link"]
        assert len(pdf.pages[1].Annots) == 0
    some = forms.create(source, "[]", remove=json.dumps(everything[:1]))
    with pikepdf.open(BytesIO(some)) as pdf:
        assert len(pdf.Root.AcroForm.Fields) == len(everything) - 1
    with pytest.raises(core.PdfToolError, match="1 to 500"):
        forms.create(source, "[]")
    protected = forms.create(form_pdf(password="secret"), "[]", password="secret", remove=json.dumps(everything[:1]))
    assert len(forms.read(protected, password="secret")["fields"]) == len(everything) - 1


def test_create_prunes_parents_left_without_children_and_keeps_siblings():
    with pikepdf.open(BytesIO(blank_pdf())) as pdf:
        page = pdf.pages[0]
        parent = pdf.make_indirect(pikepdf.Dictionary(T="address", Kids=pikepdf.Array()))
        kids = []
        for index, label in enumerate(("street", "city")):
            kid = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget, FT=pikepdf.Name.Tx, T=label, Parent=parent,
                                                       Rect=[30, 700 - 40 * index, 300, 730 - 40 * index], P=page.obj))
            parent.Kids.append(kid)
            kids.append(kid)
        page.Annots = pikepdf.Array(kids)
        pdf.Root.AcroForm = pikepdf.Dictionary(Fields=pikepdf.Array([parent]), CO=pikepdf.Array([kids[0]]))
        source = core._save(pdf)
    names = {field["name"]: field["id"] for field in forms.read(source)["fields"]}
    assert set(names) == {"address.street", "address.city"}
    one = forms.create(source, "[]", remove=json.dumps([names["address.street"]]))
    assert [field["name"] for field in forms.read(one)["fields"]] == ["address.city"]
    with pikepdf.open(BytesIO(one)) as pdf:
        assert len(pdf.Root.AcroForm.Fields) == 1 and len(pdf.Root.AcroForm.Fields[0].Kids) == 1
        assert len(pdf.Root.AcroForm.CO) == 0 and len(pdf.pages[0].Annots) == 1
    both = forms.create(source, "[]", remove=json.dumps(list(names.values())))
    with pikepdf.open(BytesIO(both)) as pdf:
        assert "/AcroForm" not in pdf.Root and len(pdf.pages[0].Annots) == 0


def test_create_rejects_unknown_or_malformed_removals_and_counts_the_remaining_fields():
    source = form_pdf()
    with pytest.raises(core.PdfToolError, match="could not be found"):
        forms.create(source, "[]", remove=json.dumps(["field-99"]))
    with pytest.raises(core.PdfToolError, match="valid JSON"):
        forms.create(source, "[]", remove="nope")
    with pytest.raises(core.PdfToolError, match="up to 500 field IDs"):
        forms.create(source, "[]", remove=json.dumps([1]))
    many = json.dumps([new_field("checkbox", f"Box {i}", width=10, height=10) for i in range(495)])
    with pytest.raises(core.PdfToolError, match="at most 500"):
        forms.create(source, many)
    assert len(forms.read(forms.create(source, many, remove=json.dumps(ids_for(source, ["notes"]))))["fields"]) == 500


def test_api_form_create_removes_fields():
    source = form_pdf()
    response = TestClient(app).post('/api/forms/create', files={'file': ('form.pdf', source, 'application/pdf')},
                                    data={'fields': '[]', 'remove': json.dumps(ids_for(source, ["plan"]))})
    assert response.status_code == 200
    assert 'form_form.pdf' in response.headers['content-disposition']
    assert "plan" not in {field["name"] for field in forms.read(response.content)["fields"]}
    bad = TestClient(app).post('/api/forms/create', files={'file': ('form.pdf', source, 'application/pdf')}, data={'fields': '[]', 'remove': json.dumps(["field-9"])})
    assert bad.status_code == 400 and "could not be found" in bad.json()['detail']
