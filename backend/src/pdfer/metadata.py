"""Targeted document metadata edits; never rebuild pages or silently repair XMP."""
import json
from io import BytesIO
from xml.etree import ElementTree as ET

import pikepdf

from pdfer import core

# Subject is dc:description. dc:subject is a separate keyword collection.
FIELDS = {
    "title": ("dc:title", "/Title"),
    "author": ("dc:creator", "/Author"),
    "subject": ("dc:description", "/Subject"),
    "keywords": ("pdf:Keywords", "/Keywords"),
}
READ_ONLY = {
    "creator": ("xmp:CreatorTool", "/Creator"),
    "producer": ("pdf:Producer", "/Producer"),
    "created": ("xmp:CreateDate", "/CreationDate"),
    "modified": ("xmp:ModifyDate", "/ModDate"),
    "metadataDate": ("xmp:MetadataDate", None),
}
MAX_FIELD_LENGTH = 5000
METADATA_ERRORS = (ValueError, TypeError, AttributeError, RuntimeError, SyntaxError, pikepdf.PdfError)
DAMAGED = "Document metadata is malformed or unsupported. Ordinary edits are disabled to avoid losing existing metadata. You can still clear document metadata."
RDF = "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}"
DC = "{http://purl.org/dc/elements/1.1/}"
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"


def _metadata(pdf):
    stream = pdf.Root.get("/Metadata")
    if stream is not None:
        if not isinstance(stream, pikepdf.Stream) or not stream.read_bytes().strip():
            raise ValueError("Invalid XMP stream")
    meta = pdf.open_metadata(set_pikepdf_as_editor=False, update_docinfo=False, strict=True)
    list(meta)  # Force parsing, including checking that XML contains XMP RDF.
    if meta.recovered:
        raise ValueError("XMP required recovery")
    # Reading a structured/URI property can return an empty string even though
    # it contains data. Check the supported common-field forms before offering
    # edits. Use pikepdf's public schema checks; never rewrite the XML ourselves.
    with pikepdf.new() as check_pdf:
        with check_pdf.open_metadata(set_pikepdf_as_editor=False, update_docinfo=False, strict=True) as check:
            check.copy_properties(meta, [key for key, _ in (FIELDS | READ_ONLY).values()])
    # pikepdf's type checks do not catch duplicate/missing language tags. An
    # update would leave a stale second default, making readers disagree.
    tree = ET.fromstring(str(meta))
    rdf = tree if tree.tag == RDF + "RDF" else tree.find(".//" + RDF + "RDF")
    for description in rdf.findall(RDF + "Description"):
        for key, container in ((DC + "title", "Alt"), (DC + "description", "Alt"), (DC + "creator", "Seq")):
            for prop in description.findall(key):
                for array in prop.findall(RDF + container):
                    nodes = [prop, array, *array]
                    if (len(prop) != 1 or (prop.text or "").strip()
                            or any(any(attr.startswith(RDF) for attr in node.attrib) for node in nodes)
                            or any(item.tag != RDF + "li" or len(item) for item in array)):
                        raise ValueError("Unsupported XMP array structure")
                    if container == "Alt":
                        languages = [item.get(XML_LANG, "") for item in array]
                        normalized = [language.lower() for language in languages]
                        if (not all(languages) or len(set(normalized)) != len(languages)
                                or any(language.lower() == "x-default" and language != "x-default" for language in languages)):
                            raise ValueError("Invalid XMP language alternatives")
    return meta


def _text(value, *, author=False):
    if value is None:
        return None
    if isinstance(value, (str, pikepdf.String)):
        return str(value)
    if author and isinstance(value, list) and all(item is None or isinstance(item, str) for item in value):
        return "; ".join(item or "" for item in value)
    raise ValueError("Unsupported metadata value")


def read(data: bytes, name: str = "document.pdf", password: str = "") -> dict:
    with core._open(data, name, password) as pdf:
        return _read(pdf)


def _read(pdf: pikepdf.Pdf) -> dict:
    warnings = []
    xmp_readable = True
    try:
        meta = _metadata(pdf)
    except METADATA_ERRORS:
        meta = {}
        xmp_readable = False
        warnings.append(DAMAGED)
    info = pdf.trailer.get("/Info", pikepdf.Dictionary())
    info_readable = isinstance(info, pikepdf.Dictionary)
    if not info_readable:
        info = {}
        warnings.append(DAMAGED)
    fields = {}
    for field, (xmp_key, info_key) in (FIELDS | READ_ONLY).items():
        values = {}
        for store, mapping, key, readable in (("xmp", meta, xmp_key, xmp_readable), ("documentInfo", info, info_key, info_readable)):
            values[store + "Readable"] = readable
            try:
                value = mapping.get(key) if key else None
                if store == "xmp" and value is None and key in mapping:
                    value = ""  # An empty default language entry is present.
                values[store] = _text(value, author=field == "author" and store == "xmp")
            except METADATA_ERRORS:
                values[store] = None
                values[store + "Readable"] = False
                warnings.append(DAMAGED)
        values["value"] = values["xmp"] if values["xmp"] is not None else values["documentInfo"]
        values["conflict"] = field in FIELDS and values["xmp"] is not None and values["documentInfo"] is not None and values["xmp"] != values["documentInfo"]
        fields[field] = values
    return {"fields": fields, "hasXmp": "/Metadata" in pdf.Root, "hasDocumentInfo": "/Info" in pdf.trailer,
            "canEdit": not warnings, "warnings": list(dict.fromkeys(warnings))}


def _changes(raw: str, clear: bool) -> dict:
    try:
        changes = json.loads(raw)
    except (ValueError, TypeError):
        raise core.PdfToolError("Metadata changes must be a JSON object.") from None
    if not isinstance(changes, dict) or any(key not in FIELDS for key in changes):
        raise core.PdfToolError("Only title, author, subject and keywords can be edited.")
    if clear and changes:
        raise core.PdfToolError("Clear document metadata cannot be combined with field edits.")
    for value in changes.values():
        if value is None:
            continue  # Explicit deletion, distinct from an omitted field.
        if not isinstance(value, str) or not value or len(value) > MAX_FIELD_LENGTH:
            raise core.PdfToolError("Metadata values must be 1–5000 characters; use null to clear a field.")
        if any(not (char in "\t\n\r" or 0x20 <= ord(char) <= 0xD7FF or 0xE000 <= ord(char) <= 0xFFFD or 0x10000 <= ord(char) <= 0x10FFFF) for char in value):
            raise core.PdfToolError("Metadata contains characters that cannot be stored in XMP.")
    return changes


def write(data: bytes, changes_json: str = "{}", clear: bool = False, name: str = "document.pdf", password: str = "") -> bytes:
    changes = _changes(changes_json, clear)
    with core._open(data, name, password) as pdf:
        if not clear and not changes:
            return data  # A true no-op, even for malformed or disagreeing metadata.
        if clear:
            # The supported removal API. Saving must not recreate XMP PDFVersion.
            if "/Metadata" in pdf.Root:
                del pdf.Root.Metadata
            if "/Info" in pdf.trailer:
                del pdf.docinfo
        else:
            if not _read(pdf)["canEdit"]:
                raise core.PdfToolError(DAMAGED)
            try:
                with _metadata(pdf) as meta:
                    for field, value in changes.items():
                        xmp_key, _ = FIELDS[field]
                        if value is None:
                            if xmp_key in meta:
                                del meta[xmp_key]
                        else:
                            meta[xmp_key] = [value] if field == "author" else value
                # Let pikepdf convert only the edited properties to DocumentInfo.
                # Syncing the whole source would overwrite unrelated conflicts,
                # delete Info-only fields, or normalize read-only dates.
                with pikepdf.new() as converted:
                    with converted.open_metadata(set_pikepdf_as_editor=False, strict=True) as synced:
                        synced.copy_properties(meta, [FIELDS[field][0] for field in changes])
                    # Info may be shared with another PDF object (for example
                    # an outline item). Detach its dictionary before changing
                    # keys so metadata edits cannot change document content.
                    pdf.docinfo = pdf.make_indirect(pikepdf.Dictionary(pdf.docinfo))
                    for field in changes:
                        _, info_key = FIELDS[field]
                        if info_key in converted.docinfo:
                            pdf.docinfo[info_key] = str(converted.docinfo[info_key])
                        elif info_key in pdf.docinfo:
                            del pdf.docinfo[info_key]
            except METADATA_ERRORS:
                raise core.PdfToolError(DAMAGED) from None
        output = BytesIO()
        # Copy the original encryption instead of replacing its passwords,
        # permissions and metadata-encryption flag with app defaults.
        pdf.save(output, encryption=pdf.is_encrypted, fix_metadata_version=False)
        return output.getvalue()
