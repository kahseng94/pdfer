# pdfer

Merge, split, organize, search, OCR, edit, compress and protect PDFs, export text or PDF pages as images, compress images or turn them into a PDF, or crop a passport photo, on your own computer.
Nothing is uploaded anywhere: the backend listens on `127.0.0.1` only.

## Requirements

- Node 20+ and [pnpm](https://pnpm.io/) for the frontend
- [uv](https://docs.astral.sh/uv/) for the backend (installs Python 3.14 for you if needed)

## Use it

```bash
pnpm install    # first time only; also runs `uv sync` for the backend
pnpm start      # builds the UI, serves it at http://127.0.0.1:8000 and opens your browser
```

Files can be dropped anywhere on the page, and images can be pasted straight
into the Images to PDF or Photo tab, or onto a page in the Edit tab. Nothing is
downloaded until you press Download on the result, which can also be opened
straight in another tool that takes it (merge, then compress, say), so only
the file you end up with lands in your downloads. A result goes away once you
change what it was made from, so it never stands in for newer settings.
To skip the browser or use another port, run the server
directly: `uv --directory backend run pdfer --no-browser --port 9000`.

### Save and resume projects

In **Edit**, **Organize**, or **Signatures**, your first edit, page arrangement
change or signature placement automatically creates a local project named after
the PDF. Further changes update that same project. Open **Saved projects** above
the tool tabs to resume after refreshing the page or restarting pdfer. The source
PDF is included, so you do not need to find or upload it again.

Projects keep text, drawings, highlights and placed images in Edit; page order,
duplicates, removals, rotations, crop/resize settings and selections in Organize;
and signature images, sizes, positions and page assignments in Signatures.
Placed images are independent copies, so deleting a signature from the library
does not break a saved project. Resumed content remains editable. Undo history
starts fresh, and output previews are rebuilt when requested.

Autosave waits one second after a change, or at most five seconds during continuous
editing. Changes made while a save is running are saved next. Leaving the tab also
starts any pending save. The controls show pending, saving, saved, or paused status;
wait for **All changes saved locally** before closing the page. Leaving or replacing
a workspace while changes are still unsaved prompts before discarding them.

Use **Save now** to save immediately or **Save as new project** to keep another
version. Editing the project name also saves automatically. An empty name pauses
autosave until you enter one. Storage errors and conflicts with another tab pause
autosave; **Retry saving** retries, and **Save as new project** keeps a separate copy.
Autosave does not repeatedly retry a failing write in the background.

**Delete** in Saved projects removes only that saved project and its stored files;
open workspaces and downloaded PDFs remain available. Autosave pauses for a deleted
project so it is not immediately recreated. Choose **Save as new project** in the
open workspace to start saving it again.

Projects use IndexedDB in the current browser profile, for the exact pdfer
address and port. They are local to this device and are not uploaded or synced.
Use the same browser and address to resume them. Clearing site data or removing
the browser profile deletes projects, and private browsing does not provide
lasting storage. Storage failures leave the last saved version intact and show
an error so you can retry. If another tab updates a project, save your changes
as a new project to avoid overwriting that version.

Original protected PDFs remain encrypted, and their passwords are never saved.
Resuming them asks for the password again. Project names, unfinished edits and
placed images are stored locally without additional encryption.

### Organize, crop and resize pages

Use **Organize** to reorder, rotate, duplicate or remove pages. Check the
pages to crop or resize; **Select all** and **Clear selection** control the
whole selection. Checkboxes follow their page cards when reordered, and
duplicate copies can be selected independently. Unchecked pages are kept
and retain their size and crop, with any explicit rotation still applied.

Enable **Crop margins** and enter top, right, bottom and left margins in mm,
or drag a rectangle on the crop reference page to choose the area to keep.
The same physical margins apply to every checked page, measured from its
visible edges after rotation. Choose another reference page to inspect the
crop on a different size or orientation. Existing crop boxes and PDF page
scaling are respected. A crop must leave at least 1 mm in each dimension
on every selected page. Cropping hides content; it is not redaction.

Enable **Resize pages** to fit the retained area proportionally onto A4,
Letter or a custom size. A4 and Letter support portrait and landscape;
custom width and height range from 1–5080 mm. Content is centered with
blank space where needed. Text, images and vector graphics remain PDF
content rather than being rasterized. Cropping happens before resizing.

Press **Preview PDF** to inspect the generated output, including the
physical size of each page. Use the page selector or Previous/Next to
review selected and unselected pages. **Download PDF** becomes available
after rendering and saves the exact previewed bytes. Changing the page
order, selection or settings clears the old preview. Preview generation
can be cancelled, and protected inputs keep their opening password.
**Reset all changes** restores the original page order, rotation and size.

### Fill PDF forms

Use **Fill forms** to edit existing standard AcroForm fields: single-line
or multiline text, checkboxes, radio groups, and single-select dropdowns
or list boxes. Editable dropdowns also accept custom text. Fields repeated
across pages share one value, and every associated widget is updated.
Read-only and unsupported fields are clearly marked. Required labels are
informational; partially completed forms can be saved.

**Show page** opens the original page for context. **Preview filled PDF**
generates the actual output before download. The copy stays interactive
by default. Enable **Flatten form fields** to make fields static while
retaining other annotations and links. Text appearances use embedded sans
fonts and fit within each field; a value that cannot fit is rejected rather
than silently truncated. Changed values, their field-tree entries and all
widget appearances are kept consistent.

XFA, multiselect choices, password/file-select/rich-text fields, and digital
signing are not supported. PDFs with existing digital signatures must be
replaced by an unsigned copy before filling or flattening. Malformed form
trees are rejected rather than guessed at. Protected inputs retain their
opening password. This tool fills existing fields; use **Edit** to place
text on a flat form.

### Bookmarks

Use **Bookmarks** to add, rename, remove and reorder document bookmarks.
Move up/down carries a whole section with its children. **Indent** creates
a subsection; **Outdent** moves a subsection after its parent's remaining
children. Removing a section removes its descendants; **Reset changes**
restores the original outline.

Choose destination pages or use **Browse document pages** and add a bookmark
for the current page. Existing named destinations, zoom/page positions,
external actions, and styles are retained when a bookmark is only renamed
or moved. Selecting a different destination replaces it with a page link.
An unresolved or external destination is shown as **Keep existing action**.
The app does not execute those actions. Preview the generated PDF, then
download the exact result or pass it to another tool. Up to 2000 bookmarks
and 17 nesting levels are supported; protected copies keep their password.

### Permanent redaction

Use **Redact** to mark rectangles on the displayed PDF pages. Drag to mark
an area, or use **Add area with controls** and enter its left/top/width/height
in physical points. Areas can be adjusted or removed, and **Undo last area**
or **Clear all areas** resets selections. Rotation, cropping and PDF page
scaling are handled in the same visible coordinate system as the preview.

**Build permanently redacted PDF** renders every page, paints opaque black
pixels over marked areas, then builds a new PDF containing only those page
images. It does not copy any original PDF objects. Original text layers,
form fields, bookmarks, links, attachments and metadata are therefore absent
from the output. Visible unmarked content remains as pixels. The original
file is preserved, and the new copy retains its opening password.

This is an **image-based redaction export**: text selection/search and
interactive features are lost on all pages. It does not perform OCR.
Choose 72, 150 (default), or 300 DPI to trade file size for sharpness. Inspect
the actual output preview before downloading. Changes invalidate old
previews, and cancellation never offers a partial PDF. Up to 1000 pages and
2000 areas are supported, with limits on pixel and file sizes; use a lower
resolution or split large documents when necessary.

### Saved workflow presets

Use **Workflows** to run the same sequence on several PDFs. The initial
example is **Watermark → Compress → Password protection**. Add, remove or
move steps up and down to build a sequence of up to eight operations:

- **Watermark:** text, opacity, position, font, size, color, margin and rotation.
- **Page numbers:** number format, starting number, document/selected-page
  numbering, position and appearance. Numbering restarts for each PDF.
- **Compress:** Light, Balanced or Strong.
- **Password protection:** add or change the opening password for every
  output PDF. A workflow can contain one protection step, in any position.

Watermarks and page numbers can target all pages or ranges such as `2-5, 8-`.
All-page scopes adapt to each PDF's length. Explicit ranges are checked
against every input before processing begins.

Give a workflow a name and press **Save preset**. Choose a saved preset to
load it; **Update preset** saves changed settings or a new name. **Save as
new preset** keeps a separate version under a different name. **Delete
preset** has an undo action. You can also run the current steps without
saving. Up to 50 presets are kept in this browser for the app's current
address, across refreshes and app restarts. A different port or browser has
its own preset library. Storage failures are reported instead of claiming
that a save succeeded.

Presets contain only names and step settings. PDFs and passwords are never
stored in them. Protected inputs prompt for their own passwords when added.
If the workflow includes protection, enter and confirm one output password
for that run. Its input fields clear after completion, cancellation or a
processing error. Passwords needed to open current files and results stay
in memory for this session so later steps and tool handoffs keep working.
Without a protection step, each PDF retains its input opening password.

Add the PDFs and press **Run workflow**. Processing runs one file and one
step at a time, with progress for both. Each step receives the previous
step's result. A failure stops the batch and identifies the file and step;
cancelled or failed runs never offer a partial download. Changing inputs
or settings clears old results and cancels an active run.

Completed batches offer one `<source>_processed.pdf` per input, with unique
names for duplicate filenames. Multiple results also get a ZIP containing
those exact PDFs. Preview individual files and pages, download a PDF, or
send it directly to another tool. Downloading always requires an explicit
click. Presets persist; open inputs, results and unfinished runs do not.

### Search and extract text

Open **Search & text** and choose a PDF, drop one anywhere on the tab, or
use another tool's **Open in Search & text** button. Text extraction runs
locally in the browser, one page at a time, with progress and cancellation.
Protected PDFs use the existing password prompt. Cancelling or replacing a
document discards unfinished extraction; **Retry extraction** starts again.

Search for a word or phrase across the document, with optional **Match
case** and **Whole words**. Phrases can span line breaks on the same page.
Search is literal, including punctuation; it does not interpret regular
expressions. Results show page numbers and snippets. Click a result or use
**Previous match** / **Next match** to navigate; Enter and Shift+Enter in
the search field also move between matches, wrapping at the ends.

Matches are highlighted in the selectable **PDF preview**, including on
rotated and scaled pages. **Extracted text** shows the same page as plain
text with matching highlights. Page navigation also works without a search.
Results are shown in groups of 40; very broad searches stop at 10,000
matches and ask for a narrower query.

Choose all pages, the current page, or page ranges such as `1-3, 5, 8-` to
copy or export. Overlapping ranges are deduplicated in document order.
Page headings are optional and retain the original page numbers, including
blank pages. **Copy text** and **Download TXT** use the same selected text;
TXT files are UTF-8 and download only when requested. Text exported from
a protected PDF has no password protection.

This feature extracts existing PDF text. Use **Recognize scanned pages** or
the **OCR** tab to add text to scanned pages or outlined letters first. Columns and tables
may have imperfect spacing or reading order. Extraction reads the PDF text
data, so cropping alone should not be used to remove sensitive text. Large
documents are bounded to 10 million extracted characters, 500,000 text
items overall and 50,000 per page; split larger PDFs before extraction.

### Local OCR

Use **OCR** to add searchable, selectable text to scanned PDF pages. Open a
PDF directly or choose **Recognize scanned pages** in Search & text. Choose
one or more installed document languages, a page range (blank means all
pages), and 300 DPI for accuracy or 150 DPI for faster processing. Overlapping
ranges are deduplicated in document order. Only selected pages without
existing non-whitespace text are recognized; a page containing any existing
text, even just a header, is skipped to avoid duplicate text. Unselected
pages and pages with text stay in the document.

Press **Recognize text**. Progress identifies the current page and stage,
and **Cancel OCR** stops rendering or the running native OCR process. A
failure identifies its page and produces no partial result. Changing the
input or settings clears the previous output. Preview the resulting PDF,
download it explicitly, or use **Open result in Search & text** to inspect,
copy, search, or export its recognized text as TXT. The original file is
preserved, and protected PDFs keep their opening password.

The browser renders each selected scan using PDF.js. Local Tesseract creates
an invisible text layer; the backend places it over the original page,
respecting rotation, crop boxes and page scaling. Original images, page
sizes, bookmarks, forms and other PDF objects are preserved. OCR does not
redact content or modify the page's visible appearance. Recognition is best
for upright printed text; it can misread characters, columns and handwriting.
Review the extracted text before relying on it. This version does not
automatically rotate or deskew scans, or replace existing OCR text.

OCR requires **Tesseract 4 or newer** and its language data on the backend
computer. Other tools continue to work without it. The OCR tab reports
missing dependencies and offers **Check again** after installation:

- macOS: `brew install tesseract` includes English. For additional languages,
  use `brew install tesseract-lang`.
- Debian/Ubuntu: `sudo apt install tesseract-ocr tesseract-ocr-eng`.
  Add language packages such as `tesseract-ocr-fra` as needed.
- Windows: install Tesseract using the options in the
  [official installation guide](https://tesseract-ocr.github.io/tessdoc/Installation.html)
  and add its executable directory to `PATH`.

Set `PDFER_TESSERACT` to the executable's absolute path if it is not on
`PATH`. `TESSDATA_PREFIX` can select a custom language-data directory.
Installed languages are detected locally; there are no automatic model
downloads or external OCR services. Recognition uses private temporary
files, deleted after success, failure or cancellation; documents and OCR
results are not saved as projects or presets.

Limits: 128 MB source PDFs, 1–1000 pages, up to eight languages per run,
32 million pixels / 32 MB per rendered PNG, 8 MB per text layer, and 64 MB
of text layers per result. Pages are processed sequentially in the browser;
the backend allows two concurrent native processes, each using at most two
OpenMP threads and timing out after three minutes. Split large documents
or lower the resolution if a limit is reached.

### Reusable signatures

Use **Signatures** to draw with a mouse, pen or finger, or import a PNG/JPEG.
Drawing supports black or blue ink, pen widths, undoing the last stroke and
clearing the pad. Imports show a prepared preview, trim transparent edges,
and optionally remove white paper while preserving antialiased ink. Give
the signature a name and press **Save signature locally**.

The library persists on this computer across browser refreshes and server
restarts. Choose a saved signature, open a PDF, select a page, then press
**Place signature on this page**. Drag it or use the Left/Top controls to
move it; resize with a corner or the Width control. Proportions stay fixed
and placements remain inside the visible page. Add copies on other pages
as needed; placement changes have undo/redo and a remove button.

**Preview signed PDF** renders the actual output before **Download PDF** is
offered. Edits require an updated preview. Rotated/cropped pages and PDF
page scaling are respected, and opening passwords are retained. Signatures
are visible image overlays. Deleting a saved library entry does not remove
copies already placed in the current document or in downloaded PDFs.

The signature library persists saved images and their names. Save a project
to also keep an open PDF and its placements between sessions. The library is a private SQLite
file under `~/Library/Application Support/pdfer/signatures/` on macOS,
`%LOCALAPPDATA%/pdfer/signatures/` on Windows, or
`$XDG_DATA_HOME/pdfer/signatures/` (default `~/.local/share/pdfer/signatures/`)
on Linux. Set `PDFER_DATA_DIR` to choose another base directory. Library
endpoints require the local app origin, and signature images use no-store
response headers. Imports are limited to PNG/JPEG files under 10 MB and
16 million pixels; saved images are normalized to PNG, at most 1600 pixels
on the longest side, with source metadata removed.

### Batch PDF compression

Drop or choose several PDFs in **Compress**, then choose Light, Balanced or
Strong. Add more PDFs to the current batch or remove individual files before
running it. Each row shows its original and compressed size, bytes saved,
and percentage saved. PDFs that do not get smaller are included unchanged.
Duplicate output filenames are made unique so every input stays in the ZIP.

Compression runs one PDF at a time with per-file progress and cancellation.
Protected inputs prompt for their own passwords, and each resulting PDF
keeps that password. A cancelled password prompt can be retried from its row.
Unreadable inputs must be removed or reopened before starting the batch.

Several PDFs produce **Download ZIP**; a single PDF keeps the existing direct
download and tool handoff options. Combined savings describe the PDFs inside
the archive; the ZIP's own size is shown separately. No download starts
automatically, and a failed or cancelled batch never offers a partial ZIP.
Changing the level or adding/removing inputs cancels any active batch and
clears outdated results. For very large archives, split the inputs into
smaller batches.

Image compression keeps its separate workflow. If a drop contains both PDFs
and images, all PDFs are added and the skipped images are reported; add the
images separately to compress them.

### Images to PDF layouts

Use **Images to PDF** to put one image on each page, in the order shown.
Drag the images to reorder them. The default layout is A4 portrait with
10 mm margins and **Fit whole image**. A4 and Letter both support portrait
or landscape orientation, and equal margins from 0–100 mm on all four sides.

- **Fit whole image** preserves proportions and centers the complete image,
  leaving extra space where needed.
- **Fill and crop** preserves proportions and fills the area inside the
  margins, cropping equally from opposite edges. The margins stay clear.
- **Stretch** fills that area by changing the image's proportions.

Choose **Image size** to keep the original behavior: each page follows its
image's own resolution and dimensions, without fixed paper layout controls.
Camera EXIF rotation and mirroring are honored in every mode. Fixed paper
layouts use the oriented pixel aspect ratio, so unusual DPI metadata does
not distort pictures. JPEG and PNG data are embedded without resampling;
transparency is preserved, with white paper behind it. Animated images use
their first frame, so each uploaded image makes exactly one page.

Press **Preview PDF** to inspect the generated document and move between
pages. **Download PDF** saves that exact preview. Adding, removing or
reordering images, or changing the layout, clears the previous preview and
cancels any preview still being built. Nothing downloads automatically.

### Page numbers and watermarks

Use **Numbers & watermarks** to apply page numbers, a text watermark, or both.
Select pages with ranges or thumbnails; overlapping ranges mark each page
once, in document order. Every original page remains in the output.

Page numbers support four formats, a starting number, and either document
page order or a sequence counting only selected pages. The total in an
“of total” format is the last number in that sequence. Numbers can be aligned
left, center or right in the header or footer. Watermarks have nine positions,
opacity from 1–100%, and rotation from −180° to 180° (negative angles rise
from left to right). Each feature has its own font, size, color and margin.
Sizes and margins are physical points (72 points per inch); text scales down
to fit the page, including rotation, inside the chosen margins.

Press **Preview changes** to generate and inspect the actual output PDF.
Use the preview's page selector or Previous/Next buttons to review marked
and unmarked pages. **Download PDF** is offered after the preview renders,
and saves those same bytes. Changing settings requires an updated preview.
Preview generation can be cancelled. Text stays selectable, page cropping
and rotation are respected, and protected inputs keep their opening password.

### Passwords

Protected PDFs prompt for their password in every PDF tool, including image
export. Incorrect passwords can be retried. Merge prompts for each protected
input separately. Passwords are held in memory for the exact files open in
the current session; they are not stored in browser storage or put in URLs.

Use **Passwords** to add or change an opening password, with confirmation,
or to create an unlocked copy. Protected copies use AES-256 and require the
chosen password to open. New passwords can use up to 127 UTF-8 bytes.
The original file is never overwritten, and a result is downloaded only
when you press Download.

Split, organize, edit, numbers/watermarks and compress retain the opening password on their PDF
outputs. Merge uses the password of the first protected input in the current
file order, shown before merging. Results passed to another tool retain
their password in memory, so they open without asking again. PDF-to-image
exports produce images and a ZIP that open without a password.

### PDF to images

Open **PDF to images**, drop a PDF, and choose PNG (lossless) or JPEG
(smaller files). All pages start selected; click thumbnails or enter ranges
such as `1-3, 5, 8-` to choose a subset. Overlapping ranges export each page
once, in document order. Choose 72, 150 (default), or 300 DPI, then export
and press **Download ZIP**. Even a single page is packaged in a ZIP.

Each image is named after the source PDF and its original page number.
Rendering respects the page's crop box and rotation, uses a white background,
and writes the selected resolution into the PNG/JPEG density metadata.
Conversion runs locally in the browser with progress and cancellation.
Very large pages or archives prompt you to lower the resolution or select
fewer pages. Nothing is downloaded until you press Download ZIP.

## Develop

```bash
pnpm dev        # API on :8000 with reload, UI on http://localhost:5173
pnpm test       # backend (pytest) and frontend (vitest)
```

The OCR tests include real recognition when Tesseract and its English language
pack are installed; that integration test is skipped otherwise. Process
cancellation, page geometry, password retention and the remaining OCR tests
run without the native engine.

The repo is a pnpm workspace with one package, `frontend`. Add frontend
dependencies with `pnpm --filter pdfer-frontend add <pkg>` and backend ones with
`uv --directory backend add <pkg>`. `uv run` keeps the Python environment in
sync with `backend/uv.lock` automatically.

## Layout

```
backend/                 Python 3.14, FastAPI, pikepdf, Pillow, img2pdf, fontTools
  src/pdfer/core.py      merge / split / organize / edit / compress (PDFs and images) / images / photo / spec parsing, no web code
  src/pdfer/fonts.py     the embedded fonts for text edits: registry, subsetting, PDF font objects
  src/pdfer/signatures.py local persistent signature-image library
  src/pdfer/forms.py     canonical AcroForm values, widget appearances and flattening
  src/pdfer/bookmarks.py outline reading/editing with preserved destinations
  src/pdfer/redactions.py image-only PDF rebuilding from masked pixels
  src/pdfer/ocr.py       local Tesseract processes and invisible text-layer assembly
  src/pdfer/fonts/       DejaVu Sans, Serif and Sans Mono; add .ttf files here for more scripts
  src/pdfer/api.py       HTTP endpoints; also serves frontend/dist if built
  tests/
frontend/                Vite, React, TypeScript, Tailwind
  src/components/        MergeTool, SplitTool, OrganizeTool (+ PdfCropEditor), BookmarksTool, FormsTool, RedactTool (+ RedactionPage), PdfToolPreview, TextTool (+ TextPage), WorkflowTool (+ WorkflowSteps, WorkflowResults), ProjectsPanel, ProjectControls, EditTool (+ EditPage), SignatureTool (+ SignatureCreator), StampTool (+ DocumentPreview), CompressTool, PdfImagesTool, PasswordTool (+ PdfPasswordDialog), ImagesTool, PhotoTool (+ PhotoCropper), Dropzone, PageThumbnail, ResultCard
  src/lib/               API client, workflow presets and sequential batch runner, the tool list and passing results between tools, pdf.js previews, text extraction/search and image export, ZIP packaging, range helpers, edit elements and geometry, fonts, passport photo sizes and crop geometry
  src/lib/projects.ts    versioned local project snapshots and atomic IndexedDB storage
  src/components/OcrTool.tsx OCR languages, ranges, progress and preview
  src/lib/ocr.ts         sequential scan rendering and OCR orchestration
```

New PDF features go in `core.py` first, then get an endpoint in `api.py`.
PDF-to-image export uses the existing pdf.js renderer in the browser and
`fflate` for ZIP packaging, so it needs no backend endpoint or native renderer.
Batch PDF compression calls the existing `/api/compress` endpoint sequentially,
with each file's password, and packages the returned PDFs locally with `fflate`.
Text search and TXT export use the existing pdf.js parser and text layer in
the browser, so no backend endpoint or OCR dependency is needed.
Workflows compose the existing stamp, compress and protect endpoints. Presets
use a validated, versioned browser-storage record; run credentials are kept
separate. Results are packaged locally with `fflate` after every file succeeds.

## API

| Endpoint | Form fields | Returns |
|---|---|---|
| `GET /api/ocr/status` | | local engine availability and installed recognition languages |
| `POST /api/ocr/page` | `image` (PNG), `languages` (e.g. `eng+fra`), `dpi` (150 or 300) | an invisible, one-page PDF text layer |
| `POST /api/ocr/assemble` | `file`, `layers` (PDF text layers), `pages` (JSON page-number list), optional `password` | `<name>_searchable.pdf`, preserving original pages and password |
| `POST /api/merge` | `files` (2 or more, in order), optional `passwords` | `merged.pdf` |
| `POST /api/split` | `file`, `mode`, `ranges`, optional `password` | a PDF, or a zip if there are several outputs |
| `POST /api/organize` | `file`, `pages`, optional `layout` (JSON), optional `password` | `<name>_organized.pdf`, used for preview and download |
| `POST /api/forms/read` | `file`, optional `password` | field IDs, values, types, options, page locations and read-only/signature status |
| `POST /api/forms/fill` | `file`, `values` (JSON object keyed by field ID), optional `flatten` (default false), optional `password` | `<name>_filled.pdf` |
| `POST /api/bookmarks/read` | `file`, optional `password` | bookmark titles, source IDs, destination pages and nesting levels |
| `POST /api/bookmarks` | `file`, `entries` (JSON array), optional `password` | `<name>_bookmarks.pdf` |
| `POST /api/redact` | `pages` (already-masked PNG images), `sizes` (JSON array of physical width/height in points), optional output `password` | a new image-only PDF; the browser names it `<name>_redacted.pdf` |
| `POST /api/edit` | `file`, `edits`, `images` (0 or more), optional `password` | `<name>_edited.pdf` |
| `GET /api/signatures` | | metadata for locally saved signature images |
| `POST /api/signatures/prepare` | `file`, optional `remove_white` | prepared PNG with `X-Image-Width` and `X-Image-Height` |
| `POST /api/signatures` | `file` (prepared PNG), `name` | saved signature metadata |
| `GET /api/signatures/<id>/image` | | saved PNG |
| `DELETE /api/signatures/<id>` | | removes the library entry |
| `POST /api/stamp` | `file`, `settings` (JSON), optional `password` | `<name>_stamped.pdf`, used for both preview and download |
| `POST /api/protect` | `file`, `new_password`, optional `password` for the source | `<name>_protected.pdf` |
| `POST /api/unlock` | `file`, optional `password` | `<name>_unlocked.pdf` |
| `GET /api/fonts` | | JSON: each family's embedded fonts in fallback order, and the code points they cover |
| `GET /api/fonts/<name>` | | the TrueType file, for previews |
| `POST /api/compress` | `file`, `level`, optional `password` | `<name>_compressed.pdf`, with `X-Original-Size` and `X-Compressed-Size` headers in bytes |
| `POST /api/compress-images` | `files` (1 or more), `level`, `format`, `max_kb` | `<name>_compressed.<ext>`, or a zip if there are several, with the same size headers plus `X-Results` |
| `POST /api/images` | `files` (JPEG or PNG, 1 or more, in order), optional `paper`, `orientation`, `margin_mm`, `fit` | `images.pdf`, one page per image; the same file is previewed and downloaded |
| `POST /api/photo` | `file` (JPEG or PNG), `crop`, `width`, `height`, `dpi`, `max_kb` | `<name>_passport.jpg`, a JPEG of `width` × `height` pixels |
| `POST /api/photo-sheet` | `file`, `crop`, `photo_width`, `photo_height`, `paper` | `<name>_passport_sheet.pdf`, with an `X-Copies` header |

`password` is the source PDF's opening password. Merge's `passwords` is a
JSON list aligned with `files`, with empty strings for unprotected inputs.
Passwords are sent as form fields to the local backend. Downloads use
`Cache-Control: no-store`.

`/api/images` accepts `paper=image|a4|letter` (default `image`),
`orientation=portrait|landscape` (default `portrait`), `margin_mm` from 0–100
(default 10), and `fit=contain|cover|stretch` (default `contain`). Orientation,
margins and fitting apply to A4/Letter; `paper=image` keeps the image's own
size. Calls that only provide `files` retain the original sizing behavior.

`/api/stamp` takes `settings` with `pages` (a range string), `numbers` and
`watermark` (either object may be `null`; at least one must be enabled).
Both objects contain `position`, `size`, `margin`, `color` and `family`
(`sans`, `serif`, `mono`). Numbers add `start`, `mode` (`document` or
`selected`) and `format` (`number`, `page`, `of-total`, `page-of-total`).
Watermarks add single-line `text` (up to 200 characters), `opacity` (0.01–1)
and clockwise `rotation` (−180 to 180). Positions are `top-left`,
`top-center`, `top-right`, `bottom-left`, `bottom-center` and `bottom-right`;
watermarks also accept `middle-left`, `center` and `middle-right`.
Number sizes are 6–72 points, watermark sizes 6–200 points, and margins
0–144 points. Margins that leave no room on a selected page are rejected.

`mode` is one of:

- `ranges`: one PDF per range in `ranges`, e.g. `1-3, 5, 8-`
- `each`: one PDF per page (`ranges` is ignored)
- `extract`: every page in `ranges`, combined into one PDF in the order given

`pages` lists the pages to keep, in order, each with an optional clockwise
rotation in degrees, e.g. `3:90, 1, 2:180`. Pages left out are dropped, and a
page may be listed more than once.

Organize's optional `layout` applies crop/resize to **1-based output
positions**, after applying the `pages` list and its rotations. This lets
copies of the same source page have different layouts. For example:

```json
{
  "pages": [1, 3],
  "crop": { "top": 10, "right": 5, "bottom": 10, "left": 5 },
  "resize": { "width": 210, "height": 297 }
}
```

Crop margins and target dimensions are physical millimetres. Set `crop`
or `resize` to `null` to disable that operation; at least one must be set.
Margins are 0–5080 mm and must leave at least 1 mm of visible page in both
dimensions. Resize dimensions are 1–5080 mm, with proportional fitting and
centering. Omitting `layout` keeps the original organize API behavior.

`edits` is a JSON list of things to draw on top of pages, each with a `type`
and a 1-based `page`. Positions and sizes are in points on the page as a viewer
shows it, measured from its top-left corner, so they match what pdf.js
displays whatever the page's rotation or crop box. Colours are `#rrggbb`.

- `text`: `x`, `y` (top-left of the text), `text` (`\n` for new lines), `size`,
  `color`, and optionally `family` (`sans`, `serif` or `mono`), `bold`, `italic`.
  Text within Latin-1 is set in the standard Helvetica, Times and Courier
  fonts, which add nothing to the file. Anything else (Greek, Cyrillic,
  symbols, …) is set in DejaVu Sans, Serif or Sans Mono, which come with pdfer
  and are embedded subset to the characters used, with bold and italic
  synthesized. For scripts DejaVu lacks, such as Chinese, Japanese or Korean,
  drop a TrueType `.ttf` that has them (Noto Sans SC, say) into
  `backend/src/pdfer/fonts/`: it becomes a fallback for every family. Scripts
  that need shaping, like Arabic or Devanagari, come out letter by letter.
- `image`: `x`, `y`, `width`, `height`, `image` (an index into `images`).
  JPEGs go in as they are; other formats are stored losslessly, with
  transparency kept.
- `rect` and `ellipse`: `x`, `y`, `width`, `height`, plus `stroke` with
  `strokeWidth`, `fill`, or both.
- `highlight`: `x`, `y`, `width`, `height`, `color`; blends like a marker pen,
  so the text under it stays readable.
- `line`: `x1`, `y1`, `x2`, `y2`, `stroke`, `strokeWidth`.
- `draw`: `points` (a list of `[x, y]`), `stroke`, `strokeWidth`; a freehand
  stroke through the points, or a dot when there is just one.

`level` is `light`, `balanced` or `strong`. Every level rewrites the file more
compactly; `balanced` and `strong` also re-encode raster images as JPEG,
downscaled so the longer side is at most 1600 px or 1000 px, while text and
vector graphics are kept exactly as they are. If nothing gets smaller the
original file comes back unchanged.

`/api/compress-images` takes the same levels for pictures on their own: every
level re-encodes without metadata (EXIF orientation applied first, colour
profile kept), `balanced` and `strong` also downscale to 1600 px or 1000 px
on the longer side, and `strong` stores PNGs in 256 colours. `format` is
`keep` (the default; JPEG, PNG and WebP stay what they are), `jpeg`, `png` or
`webp`. `max_kb` lowers the quality, then the size, until each picture fits.
With `keep` and no limit, a picture that doesn't get smaller comes back as it
is. `X-Results` is a JSON list of `{"name", "before", "after"}` per picture,
in the order sent, with names percent-encoded.

`crop` is JSON describing the part of the photo to keep, in pixels of the
picture as a browser shows it (EXIF orientation applied, origin top-left):
`{"cx": 1200, "cy": 1400, "width": 1800, "height": 2314, "angle": 2}`. The
picture is turned `angle` degrees clockwise about (`cx`, `cy`) and the
`width` × `height` rectangle centred there is kept; parts outside the picture
come out white. `/api/photo` resamples it to `width` × `height` pixels and
marks the JPEG with `dpi` (default 300); `max_kb` lowers the JPEG quality until
the file fits, for services with an upload limit. `/api/photo-sheet` prints it
`photo_width` × `photo_height` mm as many times as fit on `paper` (`4x6`,
`a4` or `letter`, turned landscape when that fits more), with 4 mm margins,
2 mm gaps and cut lines between the copies, as a one-page PDF at 300 dpi.

Errors come back as HTTP 400 with `{"detail": "..."}`.
