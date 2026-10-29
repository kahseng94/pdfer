"""AcroForm values and explicit widget appearances; no JavaScript or XFA execution."""
import json
import math
import re

import pikepdf
from pikepdf.form import Form

from pdfer import core, fonts


def _fields(pdf):
    acro = pdf.Root.get("/AcroForm")
    if acro is None:
        return Form(pdf), []
    if "/XFA" in acro:
        raise core.PdfToolError("XFA forms are not supported. Export a standard AcroForm PDF from the source application.")
    owned, visiting = set(), set()
    def walk(nodes, depth=0):
        if depth > 64: raise core.PdfToolError("This form has an excessively nested field tree.")
        for node in nodes:
            if node.objgen in visiting or len(owned) > 5000:
                raise core.PdfToolError("This form has an invalid or oversized field tree.")
            if node.objgen in owned:
                continue
            visiting.add(node.objgen)
            owned.add(node.objgen)
            walk(node.get("/Kids", []), depth + 1)
            visiting.remove(node.objgen)
    walk(acro.get("/Fields", []))
    for page in pdf.pages:
        for annot in page.get("/Annots", []):
            if annot.get("/Subtype") == pikepdf.Name.Widget and annot.objgen not in owned:
                raise core.PdfToolError("This PDF has form widgets missing from its field tree. Repair the form in its source application first.")
    form = Form(pdf)
    fields = []
    def collect(nodes):
        for node in nodes:
            # An unnamed widget child is an appearance of its parent field,
            # not a separate field whose local /V can override the parent.
            children = [child for child in node.get("/Kids", []) if child.get("/Subtype") != pikepdf.Name.Widget or "/T" in child]
            if children:
                collect(children)
            else:
                field = pikepdf.AcroFormField(node)
                name = field.fully_qualified_name or f"Unnamed field {len(fields) + 1}"
                fields.append((name, form._wrap(field, name)))
    try:
        collect(acro.get("/Fields", []))
    except (RuntimeError, ValueError, AttributeError):
        raise core.PdfToolError("This PDF contains an unsupported form-field structure.") from None
    if len(fields) > 500:
        raise core.PdfToolError("This tool supports forms with up to 500 fields.")
    return form, fields


def _widgets(form, field):
    # QPDF does not always associate radio-group parents with their child widgets.
    found = {annotation.obj.objgen: annotation.obj for annotation in form.get_annotations_for_field(field._field)}
    pending, seen = [field.obj], set()
    while pending:
        node = pending.pop()
        if node.objgen in seen: continue
        seen.add(node.objgen)
        if node.get("/Subtype") == pikepdf.Name.Widget: found[node.objgen] = node
        pending.extend(node.get("/Kids", []))
    return list(found.values())


def _signed(pdf):
    if pdf.Root.get("/Perms", {}).get("/DocMDP") is not None:
        return True
    stack = [(field, None) for field in pdf.Root.get("/AcroForm", {}).get("/Fields", [])]
    seen = set()
    while stack:
        field, inherited = stack.pop()
        if field.objgen in seen: continue
        seen.add(field.objgen)
        kind = field.get("/FT", inherited)
        if kind == pikepdf.Name.Sig and field.get("/V") is not None: return True
        stack.extend((child, kind) for child in field.get("/Kids", []))
    return False


def _description(form, name, field, index, page_map):
    widgets = _widgets(form, field)
    label = str(field.alternate_name or name or f"Field {index + 1}")
    item = {"id": f"field-{index}", "name": name or label, "label": label,
            "pages": sorted({page_map[w.objgen] for w in widgets if w.objgen in page_map}),
            "required": field.is_required, "readOnly": field.is_read_only, "type": "unsupported", "value": "", "options": [], "reason": None}
    flags = int(field.flags)
    if field.is_text and not (field.is_password or field.is_file_select or field.is_rich_text):
        item.update(type="text", value=field.value, multiline=field.is_multiline, maxLength=field.max_length)
    elif field.is_checkbox or field.is_radio_button:
        states = sorted({str(key)[1:] for widget in widgets for key in widget.get("/AP", {}).get("/N", {}).keys() if str(key) != "/Off"})
        if states and (field.is_radio_button or len(states) == 1):
            current = field._field.value
            value = str(current)[1:] if current is not None and str(current) != "/Off" else ""
            item.update(type="radio" if field.is_radio_button else "checkbox", value=value if field.is_radio_button else bool(value),
                        options=[{"value": state, "label": state} for state in states], allowEmpty=not bool(flags & (1 << 14)))
    elif field.is_choice and not field.is_multiselect:
        item.update(type="choice", value=field.value or "", editable=field.allow_edit,
                    options=[{"value": str(option.export_value), "label": str(option.display_value)} for option in field.options])
    if item["type"] == "unsupported":
        item.update(readOnly=True, reason="This field type is not editable here.")
    elif not widgets:
        item.update(readOnly=True, reason="This field has no page widget.")
    return item


def _schema(pdf, form, fields):
    page_map = {annot.objgen: index + 1 for index, page in enumerate(pdf.pages) for annot in page.get("/Annots", [])}
    return [_description(form, name, field, index, page_map) for index, (name, field) in enumerate(fields)]


def read(data: bytes, name="file", password="") -> dict:
    with core._open(data, name, password) as pdf:
        form, fields = _fields(pdf)
        return {"fields": _schema(pdf, form, fields), "pages": len(pdf.pages), "signed": _signed(pdf)}


def _rgb(value, fallback):
    try:
        values = [float(v) for v in value]
        if len(values) == 1: values *= 3
        if len(values) != 3 or not all(math.isfinite(v) and 0 <= v <= 1 for v in values): return fallback
        return tuple(values)
    except (TypeError, ValueError):
        return fallback


def _appearance(pdf, painter, widget, text, multiline=False, comb=None, align=0):
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\t", "    ")
    if not multiline: text = text.replace("\n", " ")
    rect = core._box(widget.get("/Rect"))
    if rect is None or rect[2] - rect[0] < 3 or rect[3] - rect[1] < 3:
        raise core.PdfToolError("A form field has an invalid or very small display rectangle.")
    width, height = rect[2] - rect[0], rect[3] - rect[1]
    rotation = int(widget.get("/MK", {}).get("/R", 0)) % 360
    if rotation not in (0, 90, 180, 270): raise core.PdfToolError("A form field uses an unsupported rotation.")
    if rotation in (90, 270): width, height = height, width
    padding = min(3, width / 8, height / 8)
    available = width - 2 * padding
    advances = {}
    def advance(line):
        result = 0
        for char in line:
            if char not in advances:
                font = fonts.pick("sans", char)
                if font is None: raise core.PdfToolError(f'This form value uses an unsupported character: "{char}".')
                advances[char] = font.width(char) / 1000
            result += advances[char]
        return result
    def wrap(size):
        if not multiline: return [text]
        lines = []
        for paragraph in text.split("\n"):
            line = ""
            for token in re.findall(r"\S+\s*|\s+", paragraph):
                if line and advance(line + token) * size > available:
                    lines.append(line.rstrip()); line = ""
                for char in token:
                    if line and advance(line + char) * size > available:
                        lines.append(line.rstrip()); line = ""
                    line += char
            lines.append(line.rstrip())
        return lines or [""]
    size = min(12., (height - 2 * padding) / core.TEXT_LINE_HEIGHT)
    while size >= 3:
        lines = wrap(size)
        fits = len(lines) * size * core.TEXT_LINE_HEIGHT <= height - 2 * padding and all(advance(line) * size <= available for line in lines)
        if comb:
            fits = len(text) <= comb and all(advance(char) * size <= available / comb for char in text)
        if fits: break
        size -= .5
    else:
        raise core.PdfToolError("A form value is too long to fit its field. Shorten it before exporting.")
    page = pdf.add_blank_page(page_size=(width, height))
    mk = widget.get("/MK", {})
    background, border = _rgb(mk.get("/BG"), None), _rgb(mk.get("/BC"), None)
    ops = [core._op("q"), core._op("re", 0, 0, width, height), core._op("W"), core._op("n")]
    if background:
        ops += [core._op("rg", *background), core._op("re", 0, 0, width, height), core._op("f")]
    if border:
        ops += [core._op("RG", *border), core._op("w", .6), core._op("re", .3, .3, width - .6, height - .6), core._op("S")]
    top = padding if multiline else (height - size * core.TEXT_LINE_HEIGHT) / 2
    for index, line in enumerate(list(text) if comb else lines):
        text_width = advance(line) * size
        x = padding + (available - text_width) * (0.5 if align == 1 else 1 if align == 2 else 0)
        if comb: x = padding + available / comb * index + (available / comb - text_width) / 2
        edit = core.TextEdit(page=1, x=x, y=top + (0 if comb else index * size * core.TEXT_LINE_HEIGHT), text=line, size=size, color=(0, 0, 0))
        ops += painter._embedded_text(page, edit, [line], height)
    ops.append(core._op("Q"))
    appearance = pdf.make_stream(pikepdf.unparse_content_stream(ops), Type=pikepdf.Name.XObject, Subtype=pikepdf.Name.Form,
                                 BBox=[0, 0, width, height], Resources=page.Resources)
    if rotation == 90: appearance.Matrix = [0, 1, -1, 0, height, 0]
    elif rotation == 180: appearance.Matrix = [-1, 0, 0, -1, width, height]
    elif rotation == 270: appearance.Matrix = [0, -1, 1, 0, 0, width]
    widget.AP = pikepdf.Dictionary(N=appearance)


def fill(data: bytes, spec: str, flatten=False, name="file", password="") -> bytes:
    try: changes = json.loads(spec)
    except ValueError: raise core.PdfToolError("Form values must be valid JSON.") from None
    if not isinstance(changes, dict) or len(changes) > 500: raise core.PdfToolError("Provide a form-value object with at most 500 fields.")
    with core._open(data, name, password) as pdf:
        form, fields = _fields(pdf)
        schema = _schema(pdf, form, fields)
        if not fields: raise core.PdfToolError("This PDF has no fillable fields.")
        if _signed(pdf):
            raise core.PdfToolError("This PDF contains a digital signature. Use an unsigned copy before filling or flattening it.")
        by_id = {item["id"]: (item, fields[index][1]) for index, item in enumerate(schema)}
        if any(key not in by_id for key in changes): raise core.PdfToolError("A form field could not be found. Reopen the PDF.")
        if flatten and any(item["type"] == "unsupported" and field.field_type in (pikepdf.Name.Tx, pikepdf.Name.Ch) for item, field in by_id.values()):
            raise core.PdfToolError("This form contains unsupported text or multiselect fields and cannot be flattened here.")
        regenerate_all = flatten or bool(pdf.Root.AcroForm.get("/NeedAppearances", False))
        original_pages = len(pdf.pages)
        painter = core._Painter(pdf, ())
        for identifier, (item, field) in by_id.items():
            value = changes.get(identifier, item["value"])
            if identifier in changes:
                if item["readOnly"]: raise core.PdfToolError(f'{item["label"]} is read-only.')
                if item["type"] == "checkbox":
                    if type(value) is not bool: raise core.PdfToolError("Checkbox values must be true or false.")
                    value_name = pikepdf.Name("/" + item["options"][0]["value"]) if value else pikepdf.Name.Off
                    field._field.set_value(value_name, False)
                elif item["type"] == "radio":
                    if not isinstance(value, str) or (value and value not in [option["value"] for option in item["options"]]): raise core.PdfToolError("Choose a valid radio option.")
                    if not value and item["value"] and not item["allowEmpty"]: raise core.PdfToolError("Choose a radio option instead of clearing this group.")
                    field.value = pikepdf.Name("/" + value) if value else pikepdf.Name.Off
                else:
                    if not isinstance(value, str) or len(value) > 5000: raise core.PdfToolError("Use text values of at most 5000 characters.")
                    value = value.replace("\r\n", "\n").replace("\r", "\n").replace("\t", "    ")
                    if len(value) > 5000: raise core.PdfToolError("Use text values of at most 5000 characters after expanding tabs.")
                    if any(ord(ch) < 32 and ch != "\n" for ch in value): raise core.PdfToolError("Form text cannot contain control characters.")
                    if item["type"] == "text":
                        if not item["multiline"] and "\n" in value: raise core.PdfToolError(f'{item["label"]} is a single-line field.')
                        if item["maxLength"] and len(value) > item["maxLength"]: raise core.PdfToolError(f'{item["label"]} allows at most {item["maxLength"]} characters.')
                    elif value and not item["editable"] and value not in [option["value"] for option in item["options"]]:
                        raise core.PdfToolError("Choose an available dropdown option.")
                    field._field.set_value(pikepdf.String(value), False)
                    if item["type"] == "choice":
                        field.obj.I = pikepdf.Array([i for i, option in enumerate(item["options"]) if option["value"] == value])
            widgets = _widgets(form, field)
            missing_appearance = item["type"] in ("text", "choice") and any(not isinstance(widget.get("/AP", {}).get("/N"), pikepdf.Stream) for widget in widgets)
            if identifier not in changes and not regenerate_all and not missing_appearance: continue
            if identifier in changes:
                for widget in widgets:
                    if widget.objgen != field.obj.objgen and "/T" not in widget and "/V" in widget:
                        del widget.V
            if item["type"] in ("text", "choice"):
                label = next((option["label"] for option in item["options"] if option["value"] == value), value)
                for widget in widgets:
                    _appearance(pdf, painter, widget, label, item.get("multiline", False),
                                field.max_length if item["type"] == "text" and field.is_combed else None, int(field.quadding))
            elif item["type"] in ("checkbox", "radio"):
                selected = str(field._field.value or pikepdf.Name.Off)
                for widget in widgets: widget.AS = pikepdf.Name(selected if selected in widget.get("/AP", {}).get("/N", {}) else "/Off")
        painter.finish()
        del pdf.pages[original_pages:]
        if "/AcroForm" in pdf.Root: pdf.Root.AcroForm.NeedAppearances = False
        if flatten:
            other = []
            for page in pdf.pages:
                annotations = list(page.get("/Annots", []))
                other.append([annot for annot in annotations if annot.get("/Subtype") != pikepdf.Name.Widget])
                page.Annots = pikepdf.Array([annot for annot in annotations if annot.get("/Subtype") == pikepdf.Name.Widget])
            pdf.flatten_annotations()
            for page, annotations in zip(pdf.pages, other): page.Annots = pikepdf.Array(annotations)
            if "/AcroForm" in pdf.Root: del pdf.Root.AcroForm
        return core._save(pdf, password if pdf.is_encrypted else "", min_version="1.4")
