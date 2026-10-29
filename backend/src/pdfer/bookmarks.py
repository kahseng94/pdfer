"""Read and edit PDF outlines, preserving existing destination details and actions."""
import copy
import json

import pikepdf

from pdfer import core

MAX_BOOKMARKS = 2000
MAX_DEPTH = 16


def _entries(pdf: pikepdf.Pdf):
    pages = {page.obj.objgen: index + 1 for index, page in enumerate(pdf.pages)}
    entries = []
    originals = {}
    outline = pdf.open_outline(max_depth=MAX_DEPTH + 1, strict=True)

    def walk(items, level):
        if items and level > MAX_DEPTH:
            raise core.PdfToolError(f"Bookmarks can be nested up to {MAX_DEPTH + 1} levels.")
        for item in items:
            if len(entries) >= MAX_BOOKMARKS:
                raise core.PdfToolError(f"This tool supports up to {MAX_BOOKMARKS} bookmarks.")
            identifier = f"bookmark-{len(entries)}"
            destination = item.resolved_destination(pdf)
            page = pages.get(destination.page.objgen) if destination is not None else None
            entry = {"id": identifier, "sourceId": identifier, "title": item.title, "page": page, "level": level}
            entries.append(entry)
            originals[identifier] = (item, page)
            walk(item.children, level + 1)
    try:
        walk(outline.root, 0)
    except (pikepdf.OutlineStructureError, ValueError, AttributeError, RecursionError):
        raise core.PdfToolError("This PDF has a damaged bookmark structure. Repair it before editing bookmarks.") from None
    return entries, originals


def read(data: bytes, name="file", password="") -> dict:
    with core._open(data, name, password) as pdf:
        entries, _ = _entries(pdf)
        return {"bookmarks": entries, "pages": len(pdf.pages)}


def write(data: bytes, spec: str, name="file", password="") -> bytes:
    try:
        entries = json.loads(spec)
    except ValueError:
        raise core.PdfToolError("Bookmarks must be valid JSON.") from None
    if not isinstance(entries, list) or len(entries) > MAX_BOOKMARKS:
        raise core.PdfToolError(f"Provide at most {MAX_BOOKMARKS} bookmarks.")
    with core._open(data, name, password) as pdf:
        _, originals = _entries(pdf)
        roots = []
        ancestors = []
        ids, used_sources = set(), set()
        for index, entry in enumerate(entries):
            if not isinstance(entry, dict):
                raise core.PdfToolError(f"Bookmark {index + 1} must be an object.")
            title, level, page = entry.get("title"), entry.get("level"), entry.get("page")
            identifier, source_id = entry.get("id"), entry.get("sourceId")
            if not isinstance(identifier, str) or not identifier or identifier in ids:
                raise core.PdfToolError("Each bookmark must have a unique ID.")
            ids.add(identifier)
            if not isinstance(title, str) or not title.strip() or len(title) > 200 or any(ord(ch) < 32 for ch in title):
                raise core.PdfToolError(f"Bookmark {index + 1}: use a single-line title of 1–200 characters.")
            if type(level) is not int or not 0 <= level <= MAX_DEPTH or level > len(ancestors):
                raise core.PdfToolError(f"Bookmark {index + 1} has an invalid nesting level.")
            original = None
            if source_id is not None:
                if not isinstance(source_id, str) or source_id not in originals or source_id in used_sources:
                    raise core.PdfToolError("An existing bookmark was duplicated or could not be found. Reopen the PDF.")
                original = originals[source_id]
                used_sources.add(source_id)
            if page is not None and (type(page) is not int or not 1 <= page <= len(pdf.pages)):
                raise core.PdfToolError(f"Bookmark {index + 1}: choose a page from 1 to {len(pdf.pages)}.")
            if original is None and page is None:
                raise core.PdfToolError("New bookmarks need a destination page.")
            if original:
                item = copy.copy(original[0])
                item.title = title.strip()
                item.children = []
                if page != original[1]:
                    if page is None:
                        raise core.PdfToolError("Choose a destination page for this bookmark.")
                    item.destination = page - 1
                    item.action = None
                    item.page_location = None
                    item.page_location_kwargs = {}
            else:
                item = pikepdf.OutlineItem(title.strip(), page - 1)
            ancestors = ancestors[:level]
            (ancestors[-1].children if ancestors else roots).append(item)
            ancestors.append(item)
        with pdf.open_outline(max_depth=MAX_DEPTH + 1) as outline:
            outline.root = roots
        if roots:
            pdf.Root.PageMode = pikepdf.Name.UseOutlines
        elif pdf.Root.get("/PageMode") == pikepdf.Name.UseOutlines:
            del pdf.Root.PageMode
        return core._save(pdf, password if pdf.is_encrypted else "")
