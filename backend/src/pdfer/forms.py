"""AcroForm values and explicit widget appearances; no JavaScript or XFA execution.

`create` adds new text, checkbox, dropdown and radio fields to a PDF, with
appearances written out so every viewer shows them, and leaves existing fields
untouched. `read` and `fill` work on the fields a PDF has.

Hybrid XFA forms also carry a complete AcroForm field tree, so they are filled
through that tree and saved without the XFA layer. Dynamic XFA forms have no
usable AcroForm widgets and are rejected.
"""
import json
import math
import re

import pikepdf
from pikepdf.form import Form

from pdfer import core, fonts

DYNAMIC_XFA = ("This is a dynamic XFA form, which only Adobe Acrobat or Reader can fill. "
               "Fill it there, or export a standard PDF form from the source application.")


def _has_xfa(pdf):
    return "/XFA" in pdf.Root.get("/AcroForm", {})


def _fields(pdf):
    acro = pdf.Root.get("/AcroForm")
    if acro is None:
        return Form(pdf), []
    xfa = "/XFA" in acro
    if xfa and bool(pdf.Root.get("/NeedsRendering", False)):
        raise core.PdfToolError(DYNAMIC_XFA)
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
    has_widgets = False
    for page in pdf.pages:
        for annot in page.get("/Annots", []):
            if annot.get("/Subtype") == pikepdf.Name.Widget:
                if annot.objgen not in owned:
                    raise core.PdfToolError("This PDF has form widgets missing from its field tree. Repair the form in its source application first.")
                has_widgets = True
    if xfa and not has_widgets:
        raise core.PdfToolError(DYNAMIC_XFA)
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


def _frames(pdf):
    """For each page, what maps PDF user space back to display points (top-left origin, y down)."""
    frames = []
    for page in pdf.pages:
        frame, _, height = core._display_frame(page)
        frames.append((pikepdf.Matrix(*frame).inverse(), height, core._region_unit(page)))
    return frames


def _display_box(frame, rect):
    inverse, height, unit = frame
    box = inverse.transform(pikepdf.Rectangle(*rect))
    return {"x": round(box.llx * unit, 2), "y": round((height - box.ury) * unit, 2),
            "width": round(box.width * unit, 2), "height": round(box.height * unit, 2)}


def _description(form, name, field, index, page_map, frames):
    widgets = _widgets(form, field)
    label = str(field.alternate_name or name or f"Field {index + 1}")
    placed = []
    for widget in widgets:
        rect = core._box(widget.get("/Rect"))
        if widget.objgen in page_map and rect is not None:
            number = page_map[widget.objgen]
            placed.append(({"page": number, **_display_box(frames[number - 1], rect)}, widget))
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
    if item["type"] in ("checkbox", "radio"):
        # Each checkbox or radio button widget turns on one state; say which, so it can be clicked on the page.
        for box, widget in placed:
            appearances = widget.get("/AP", {}).get("/N")
            states = [str(key)[1:] for key in appearances.keys() if str(key) != "/Off"] if isinstance(appearances, pikepdf.Dictionary) else []
            if len(states) == 1: box["option"] = states[0]
    item["boxes"] = sorted((box for box, _ in placed), key=lambda box: (box["page"], box["y"], box["x"]))
    return item


def _schema(pdf, form, fields):
    page_map = {annot.objgen: index + 1 for index, page in enumerate(pdf.pages) for annot in page.get("/Annots", [])}
    frames = _frames(pdf)
    return [_description(form, name, field, index, page_map, frames) for index, (name, field) in enumerate(fields)]


def read(data: bytes, name="file", password="") -> dict:
    with core._open(data, name, password) as pdf:
        form, fields = _fields(pdf)
        return {"fields": _schema(pdf, form, fields), "pages": len(pdf.pages), "signed": _signed(pdf), "xfa": _has_xfa(pdf)}


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
    _rotate(appearance, rotation, width, height)
    widget.AP = pikepdf.Dictionary(N=appearance)


def _rotate(appearance, rotation, width, height):
    # width and height are the upright appearance's, already swapped for 90 and 270.
    if rotation == 90: appearance.Matrix = [0, 1, -1, 0, height, 0]
    elif rotation == 180: appearance.Matrix = [-1, 0, 0, -1, width, height]
    elif rotation == 270: appearance.Matrix = [0, -1, 1, 0, 0, width]


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
        _drop_xfa_and_usage_rights(pdf)
        return core._save(pdf, password if pdf.is_encrypted else "", min_version="1.4")


_TYPES = ("text", "checkbox", "choice", "radio")
_REQUIRED, _MULTILINE, _NO_TOGGLE_OFF, _RADIO, _COMBO, _EDIT = 1 << 1, 1 << 12, 1 << 14, 1 << 15, 1 << 17, 1 << 18
_BORDER = (0.55, 0.55, 0.55)
_MIN_FIELD = 8


def _plain(value, label, low, high):
    if not isinstance(value, str):
        raise core.PdfToolError(f"{label} must be text.")
    value = value.strip()
    if not low <= len(value) <= high:
        raise core.PdfToolError(f"{label} must be {low}–{high} characters." if low else f"{label} must be at most {high} characters.")
    if any(ord(ch) < 32 or 0x7F <= ord(ch) < 0xA0 for ch in value):
        raise core.PdfToolError(f"{label} cannot contain control characters.")
    return value


def _new_fields(spec, pdf, taken, existing):
    try: items = json.loads(spec)
    except ValueError: raise core.PdfToolError("Form fields must be valid JSON.") from None
    if not isinstance(items, list) or not 1 <= len(items) <= 500:
        raise core.PdfToolError("Provide a list of 1 to 500 form fields.")
    frames, entries = {}, []
    for index, item in enumerate(items, 1):
        label = f"Field {index}"
        f = core._Fields(item, label)
        kind = f.choice("type", _TYPES)
        name = _plain(f._raw("name"), f"{label}: the name", 1, 100)
        if "." in name: raise core.PdfToolError(f'{label}: field names cannot contain ".".')
        number = f.page(len(pdf.pages))
        page = pdf.pages[number - 1]
        x, y, w, h = (f.num(key) for key in ("x", "y", "width", "height"))
        if number not in frames: frames[number] = (*core._display_frame(page), core._region_unit(page))
        frame, width, height, unit = frames[number]
        if min(x, y) < 0 or min(w, h) < _MIN_FIELD or x + w > width * unit + 0.02 or y + h > height * unit + 0.02:
            raise core.PdfToolError(f"{label} must fit inside page {number} and be at least {_MIN_FIELD} points wide and high.")
        rect = pikepdf.Matrix(*frame).transform(pikepdf.Rectangle(x / unit, height - (y + h) / unit, (x + w) / unit, height - y / unit))
        entry = {"label": label, "kind": kind, "name": name, "page": page, "number": number, "x": x, "y": y,
                 "rect": [round(v, 3) for v in (rect.llx, rect.lly, rect.urx, rect.ury)], "rotation": page.rotation,
                 "required": f.flag("required"),
                 "tooltip": "" if item.get("label") in (None, "") else _plain(item["label"], f"{label}: the label", 0, 200)}
        if kind == "text":
            max_length = item.get("maxLength")
            if max_length is not None and (type(max_length) is not int or not 1 <= max_length <= 5000):
                raise core.PdfToolError(f"{label}: the maximum length must be a whole number from 1 to 5000.")
            entry.update(multiline=f.flag("multiline"), max_length=max_length)
        elif kind == "choice":
            options = item.get("options")
            if not isinstance(options, list) or not 1 <= len(options) <= 100:
                raise core.PdfToolError(f"{label}: a dropdown needs 1 to 100 options.")
            options = [_plain(option, f"{label}: each option", 1, 200) for option in options]
            if len(set(options)) != len(options): raise core.PdfToolError(f"{label}: dropdown options must be different from each other.")
            entry.update(options=options, editable=f.flag("editable"))
        elif kind == "radio":
            option = _plain(f._raw("option"), f"{label}: the option", 1, 60)
            if option == "Off": raise core.PdfToolError(f'{label}: "Off" is reserved; choose another option name.')
            entry["option"] = option
        entries.append(entry)
    singles, groups = set(), {}
    for entry in entries:
        name = entry["name"]
        if name in taken: raise core.PdfToolError(f'{entry["label"]}: this PDF already has a field named "{name}".')
        if (name in singles) or (entry["kind"] != "radio" and name in groups):
            raise core.PdfToolError(f'{entry["label"]}: another new field is already named "{name}".')
        if entry["kind"] == "radio": groups.setdefault(name, []).append(entry)
        else: singles.add(name)
    for name, buttons in groups.items():
        if len(buttons) < 2: raise core.PdfToolError(f'Radio group "{name}" needs at least 2 buttons.')
        options = [button["option"] for button in buttons]
        if len(set(options)) != len(options): raise core.PdfToolError(f'Radio group "{name}" has two buttons with the same option.')
    if existing + len(singles) + len(groups) > 500:
        raise core.PdfToolError(f"A form can have at most 500 fields. This PDF already has {existing}.")
    # Viewers tab through fields in this order, so follow the reading order rather than the drawing order.
    return sorted(entries, key=lambda entry: (entry["number"], round(entry["y"]), entry["x"]))


def _acroform(pdf):
    if "/AcroForm" not in pdf.Root: pdf.Root.AcroForm = pikepdf.Dictionary()
    acro = pdf.Root.AcroForm
    if "/Fields" not in acro: acro.Fields = pikepdf.Array()
    if "/DA" not in acro: acro.DA = pikepdf.String("/Helv 0 Tf 0 g")
    if "/DR" not in acro: acro.DR = pikepdf.Dictionary()
    if "/Font" not in acro.DR: acro.DR.Font = pikepdf.Dictionary()
    for key, font in (("/Helv", "/Helvetica"), ("/ZaDb", "/ZapfDingbats")):
        if key not in acro.DR.Font:
            acro.DR.Font[key] = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name(font)))
    return acro


def _toggle_appearance(pdf, widget, radio, on):
    rect = core._box(widget.Rect)
    width, height = rect[2] - rect[0], rect[3] - rect[1]
    rotation = int(widget.MK.get("/R", 0)) % 360
    if rotation in (90, 270): width, height = height, width
    side = min(width, height)
    ops = [core._op("q")]
    border = _rgb(widget.MK.get("/BC"), None)
    if radio:
        cx, cy, radius = width / 2, height / 2, side / 2 - .5
        if border: ops += [core._op("RG", *border), core._op("w", .6), *core._ellipse(cx, cy, radius, radius), core._op("S")]
        if on: ops += [core._op("rg", 0, 0, 0), *core._ellipse(cx, cy, radius * .5, radius * .5), core._op("f")]
    else:
        if border: ops += [core._op("RG", *border), core._op("w", .6), core._op("re", .3, .3, width - .6, height - .6), core._op("S")]
        if on:
            left, bottom = (width - side) / 2, (height - side) / 2
            tick = [(.22, .52), (.42, .3), (.78, .72)]
            ops += [core._op("RG", 0, 0, 0), core._op("w", side * .1), core._op("J", 1), core._op("j", 1),
                    core._op("m", left + tick[0][0] * side, bottom + tick[0][1] * side),
                    *[core._op("l", left + tx * side, bottom + ty * side) for tx, ty in tick[1:]], core._op("S")]
    ops.append(core._op("Q"))
    appearance = pdf.make_stream(pikepdf.unparse_content_stream(ops), Type=pikepdf.Name.XObject, Subtype=pikepdf.Name.Form,
                                 BBox=[0, 0, width, height], Resources=pikepdf.Dictionary())
    _rotate(appearance, rotation, width, height)
    return appearance


def create(data: bytes, spec: str, name="file", password="") -> bytes:
    """Add new fields; the PDF's existing fields, values and appearances are left as they are."""
    with core._open(data, name, password) as pdf:
        if _signed(pdf):
            raise core.PdfToolError("This PDF contains a digital signature. Use an unsigned copy before adding form fields.")
        _form, fields = _fields(pdf)
        top = pdf.Root.get("/AcroForm", {}).get("/Fields", [])
        taken = {field_name for field_name, _ in fields} | {str(node.T) for node in top if "/T" in node}
        entries = _new_fields(spec, pdf, taken, len(fields))
        acro = _acroform(pdf)
        original_pages = len(pdf.pages)
        painter = core._Painter(pdf, ())
        groups = {}
        for entry in entries:
            kind = entry["kind"]
            widget = pdf.make_indirect(pikepdf.Dictionary(
                Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget, Rect=entry["rect"], P=entry["page"].obj, F=4,
                MK=pikepdf.Dictionary(BC=list(_BORDER), R=entry["rotation"]), BS=pikepdf.Dictionary(W=1, S=pikepdf.Name.S)))
            flags = _REQUIRED if entry["required"] else 0
            if kind in ("checkbox", "radio"):
                on_state = entry["option"] if kind == "radio" else "Yes"
                states = pikepdf.Dictionary(Off=_toggle_appearance(pdf, widget, kind == "radio", False))
                states["/" + on_state] = _toggle_appearance(pdf, widget, kind == "radio", True)
                widget.AP = pikepdf.Dictionary(N=states)
                widget.AS = pikepdf.Name.Off
                widget.DA = pikepdf.String("/ZaDb 0 Tf 0 g")
                widget.MK.CA = pikepdf.String("l" if kind == "radio" else "4")
            if kind == "radio":
                group = groups.get(entry["name"])
                if group is None:
                    group = groups[entry["name"]] = pdf.make_indirect(pikepdf.Dictionary(
                        FT=pikepdf.Name.Btn, T=pikepdf.String(entry["name"]), Ff=_RADIO | _NO_TOGGLE_OFF, V=pikepdf.Name.Off, Kids=pikepdf.Array()))
                    acro.Fields.append(group)
                group.Ff = int(group.Ff) | flags
                if entry["tooltip"] and "/TU" not in group: group.TU = pikepdf.String(entry["tooltip"])
                widget.Parent = group
                group.Kids.append(widget)
            else:
                widget.T = pikepdf.String(entry["name"])
                if entry["tooltip"]: widget.TU = pikepdf.String(entry["tooltip"])
                if kind == "checkbox":
                    widget.FT, widget.V = pikepdf.Name.Btn, pikepdf.Name.Off
                else:
                    widget.DA, widget.V = pikepdf.String("/Helv 0 Tf 0 g"), pikepdf.String("")
                    if kind == "text":
                        widget.FT = pikepdf.Name.Tx
                        if entry["multiline"]: flags |= _MULTILINE
                        if entry["max_length"]: widget.MaxLen = entry["max_length"]
                    else:
                        widget.FT = pikepdf.Name.Ch
                        flags |= _COMBO | (_EDIT if entry["editable"] else 0)
                        widget.Opt = pikepdf.Array([pikepdf.String(option) for option in entry["options"]])
                    _appearance(pdf, painter, widget, "", entry.get("multiline", False))
                if flags: widget.Ff = flags
                acro.Fields.append(widget)
            page = entry["page"]
            if "/Annots" not in page.obj: page.obj.Annots = pikepdf.Array()
            page.obj.Annots.append(widget)
        painter.finish()
        del pdf.pages[original_pages:]
        _drop_xfa_and_usage_rights(pdf)
        return core._save(pdf, password if pdf.is_encrypted else "", min_version="1.4")


def _drop_xfa_and_usage_rights(pdf):
    # Acrobat prefers XFA data over AcroForm values, so a kept XFA layer would
    # show the old answers. Reader usage rights are signed over the original
    # bytes; once the form is filled they are invalid and Reader shows an error.
    acro = pdf.Root.get("/AcroForm")
    if acro is not None and "/XFA" in acro: del acro.XFA
    if "/NeedsRendering" in pdf.Root: del pdf.Root.NeedsRendering
    perms = pdf.Root.get("/Perms")
    if perms is not None:
        for key in ("/UR", "/UR3"):
            if key in perms: del perms[key]
        if not perms.keys(): del pdf.Root.Perms
