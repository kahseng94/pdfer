# pdfer

Merge, split, organize, compare, search, OCR, edit, compress and protect PDFs, export text or PDF pages as images, compress images or turn them into a PDF, or crop a passport photo, on your own computer.
Nothing is uploaded anywhere: the backend listens on `127.0.0.1` only.

## Desktop app

Run `pnpm desktop:dev` to open the Electron app, or `pnpm desktop:build` to
create an installer for this computer. Desktop installers include Python,
the PDF libraries, and English OCR. PaddleOCR has an optional in-app setup.
Published releases support **Download update → Restart to update**.
See [desktop setup and releases](desktop/README.md) for build prerequisites,
signing, local data, and the GitHub release workflow.

## Requirements

- Node 24 and [pnpm](https://pnpm.io/) for the frontend and desktop build
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

Projects keep text, drawings, highlights, placed images and moved regions in Edit; page order,
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

### Move existing PDF content

In **Edit**, choose **Move region** and drag a rectangle around the part of the
original page to move. The editor returns to **Select**: drag the selected block
to another position, or choose **Move to page** to move it to a different
page in the PDF. The editor scrolls to that page and keeps the region selected.
You can also drag the selected region directly onto another displayed page.
Hold it near the top or bottom of the editing area to scroll while dragging.
The grabbed point stays under the pointer when the region fits a smaller page.
Releasing between pages keeps it inside the last page reached; Escape cancels
the drag. A whole drag, including crossing pages, is one undo step.
The source page stays fixed, even if you change the destination again.
Regions that are too large for a smaller page shrink proportionally to fit.
Drag a corner to resize it. Corners
preserve its proportions; hold Shift to stretch. **Left**, **Top**, **Width** and
**Height** give precise control in points. Arrow keys nudge the selected region
by one point, or ten with Shift. Selections and destinations stay inside the page.

Use **Rotate region left/right** to turn a selected region by 90 degrees, or
choose **0°, 90°, 180° or 270°** under **Rotation**. Rotation is clockwise from
the original crop's orientation. The region stays centered where possible;
its visible width and height swap on a quarter turn, with proportional fitting
and position adjustment if needed to keep it inside the page. Dragging and
resizing use this rotated box. Each rotation is one undo step. Copies inherit
the selected region's rotation and can then be rotated independently. Rotation
is saved in projects and preserved in PDF exports without rasterizing the content.

To duplicate a selected region, choose a page in **Copy to page** and press
**Copy region**. The selected region stays where it is; a new, independent copy
is selected on the target page. Its size and proportions are preserved unless
it must shrink to fit. Choose **Page N (current)** to duplicate on the same page,
including in a one-page PDF. The copy is offset by up to 12 points within the
page bounds and remains selected, ready to drag to a new position. The view stays
where you are. Copies can be moved, resized or copied again. They always
refer to the original PDF content, so deleting or restoring another region does
not change them. Creating a copy is one undo step, and copies are saved in projects
and exported without rasterizing their text or vector graphics.

Use **Delete region**, Delete, or Backspace to remove the selected cutout from
the visible layout. Its original source stays covered with white. If it was moved
to another page, the content underneath its former destination becomes visible
again. Deletion is one undo step and is saved with the project.
For a copy, **Delete copy**, Delete or Backspace removes only that copy and leaves
the original and any other copies in place. It can be undone as usual.

**Restore original** cancels the region edit and reveals its original location.
Expand **Deleted regions** to restore individual deleted areas, including after
reopening a project. **Clear all** restores all regions and removes the other
edits. Each selection, move and resize is also one undo step. Saved projects retain
the source rectangle, source page, destination, rotation, copy flag and deletion state.
Older projects containing same-page regions also remain supported. Use **Save
with edits**, then **Download**, to export the finished PDF.

Move region shows the original page while choosing a source, with existing source
rectangles shaded. It always samples original content, including scanned images,
before added text, drawings or other region moves. Select separate areas for moves
and deletions; their source rectangles cannot overlap. Copies can share a source
with each other or with a moved/deleted region, since copies never cover the source.
Destinations can overlap, with later edits on top. Up to 200 regions are supported
in total, including copies and deletions, each at least 2 points wide and high.

Vacated areas become white, and the moved rectangle includes its background.
This is best for rearranging blocks on plain pages. Export uses clipped original
PDF content, preserving text and vector quality without rasterizing the page.
It changes the visible layout: original objects remain in the file and can still
be searched or extracted. It is **not redaction**; use **Redact** for sensitive
content. A source or destination touching a link, annotation or form field is
rejected on export, since those interactive objects cannot move with a region.

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

### Metadata

Use **Metadata** to view and edit a PDF's title, author, subject and keywords.
Each field offers **Keep original**, **Edit**, and **Clear field**. Keep leaves
both original representations untouched, including any existing disagreement;
Edit updates that field in both XMP and legacy DocumentInfo. The UI shows both
stored values, preferring XMP for the editable starting value. Choosing Edit
and applying the displayed value explicitly reconciles a conflict. Clear field
removes the property from both stores; an empty edit is rejected rather than
silently interpreted as deletion. Values can contain Unicode, up to 5000
characters per edited field.

Author edits store one author value; existing multi-author lists stay intact
when kept. Subject means the document description (`dc:description`), and
keywords means PDF keywords (`pdf:Keywords`); the separate XMP `dc:subject`
keyword list is preserved. Title and subject edits also update language
variants whose text matches the old default, following pikepdf's XMP editing
behavior; translations with different text are preserved. Clearing either
field removes all its translations. Creator,
producer, creation/modification dates and metadata date are shown read-only,
as stored, and remain unchanged during ordinary edits. Custom metadata and
all other unedited fields are preserved. The implementation uses pikepdf's
supported metadata editing/copying and DocumentInfo conversion APIs.

**Clear document metadata** stages removal of the entire document XMP packet
and DocumentInfo dictionary, including custom fields and the read-only fields.
**Reset changes** cancels this choice. This is not a complete privacy scrub:
comments, attachments, page/image metadata, and other hidden content elsewhere
in the PDF remain. Malformed or unsupported document metadata disables ordinary
edits to avoid silent repair/data loss; explicit document clearing is still
available. Unsupported structured values and ambiguous language alternatives
are rejected before editing. Unreadable metadata is labeled **Unavailable**,
separately from absent fields and empty values.

Preview builds a new copy, reads its metadata back, and renders its actual
pages before offering **Download PDF** or a handoff to another tool. Changes
invalidate previous results, and cancelled or superseded work cannot offer a
stale download. Source files are never overwritten. Pages, selectable text,
images, bookmarks, forms, annotations and attachments are retained. Existing
encryption, user and owner passwords, permissions and the metadata-encryption
setting are preserved, including PDFs that open with an empty user password.
As with other PDF rewrites, existing cryptographic signatures are
not preserved as valid signatures. All processing stays local; this tool needs
no new dependency or cloud service.

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

### Compare PDFs

Open **Compare PDFs** and choose an **Original** and **Revised** PDF. Each
protected input prompts for its own password using the usual session-only
password handling. A single window drop or **Open in Compare PDFs** handoff
fills Original first, then fills or replaces Revised. Dropping two files
replaces both in file order; the labeled input areas replace only their side.

Press **Compare PDFs** to compare actual pdf.js-rendered pages locally in the
browser. The tool does not compare file bytes: different PDF stream encodings
with the same rendered content and text compare as unchanged. Blank and scanned
pages work without OCR. Extractable text is also compared, so changes in an
invisible OCR layer can be reported even when page images look identical.

Pages pair strictly by number: original page 1 with revised page 1, and so on.
There is **no automatic page alignment or semantic interpretation**. A middle
insertion may change all following pairs. A page without a counterpart at the
same number is marked **added** or **removed**, including blank pages. Other
pairs are **unchanged** or **changed** based on visible content, displayed page
dimensions, and extracted text. Metadata and whitespace-only text changes are
ignored. Reading order can vary in columns, tables and OCR layers.

Both previews share page navigation and a physical scale, aligned at their
visible top-left corners. Crop boxes, rotation and PDF UserUnit scaling are
respected; different page sizes are never stretched to match. Pink regions
show visual differences on both sides. **Previous difference** and **Next
difference** wrap through visual regions, dimension changes, text changes and
added/removed pages; orange marks the selected visual region or page boundary.
The page selector includes every page's status, including unchanged pairs.
Readable **Removed** and **Added** blocks show literal text changes. Missing
or excessive text is clearly flagged as visual-only comparison.

The default is **96 DPI / Balanced**: color-channel changes up to 24/255 and
isolated groups smaller than four pixels are ignored. Precise uses 8/255 and
one pixel; Relaxed uses 48/255 and twelve pixels. These settings can miss tiny
or low-contrast changes; unchanged means no differences detected at the chosen
resolution and tolerance. Use 144 DPI / Precise to inspect finer details.
Changed pixels are grouped into adjacent 12-pixel tiles; over 200 regions on
one page are shown as a combined bounding region. Long text replacements use
one block to bound diff computation.

Processing runs one page pair at a time, with progress and cancellation.
Only the current pair's rasters are kept while comparing; completed results
store small region coordinates and text edits. Previews render the selected
pair on demand. Preview and comparison renders share a queue, including the
cleanup of cancelled renders. PDF.js document caches are released between
pairs. Text extraction reads bounded chunks and cancels its stream on a limit
or cancellation, without first accumulating the whole page. Limits are
100 MB and 1000 pages per input, 2 million pixels
and 2400 pixels per side per rendered pair, 1 billion cumulative pair pixels,
100,000 extracted characters / 50,000 text items per page and 4 million total
extracted characters. Large pages automatically use a lower DPI, shown in the
results. PDF.js parsing and decoded source images can require additional memory.
Split large or unusually complex PDFs into smaller documents when necessary.

Replacing either input or changing comparison settings cancels work and clears
old results. Cancelled or failed runs never offer a partial report. Downloading
the optional comparison TXT requires an explicit click; it includes statuses,
text edits and geometry summaries, but no preview images or passwords. Text
reports from protected PDFs are unencrypted. The originals are never modified,
and this tool makes no backend requests or external uploads.

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
**Tesseract** (the default) or optional **PaddleOCR PP-OCRv6 · medium**.
Tesseract offers installed language packs; Paddle uses automatic multilingual
recognition. Choose a page range (blank means all pages), and 300 DPI for
accuracy or 150 DPI for faster processing. Overlapping ranges are deduplicated
in document order. Only selected pages without
existing non-whitespace text are recognized; a page containing any existing
text, even just a header, is skipped to avoid duplicate text. Unselected
pages and pages with text stay in the document.

Enable **Automatically correct sideways or upside-down scans** to turn
selected scanned pages upright before recognition. This option requires
Tesseract and its local `osd` language pack with either engine; install them
and choose **Check again** if the option is disabled. Only confident 90°, 180°
or 270° corrections are applied. Sparse, blank or uncertain pages keep their
orientation, so review
the preview and use Organize to rotate them manually if needed. The result
reports how many pages were rotated. Existing-text and unselected pages
keep their original orientation. Paddle recognition works without Tesseract
when automatic rotation is off.

Press **Recognize text**. Progress identifies the current page and stage,
and **Cancel OCR** stops rendering or the running native OCR process. A
failure identifies its page and produces no partial result. Changing the
input or settings clears the previous output. Switching engines cancels any
active run and clears its preview; failures never silently switch engines.
Preview the resulting PDF, download it explicitly, or use **Open result in
Search & text** to inspect, copy, search, or export its recognized text as TXT.
The original file is
preserved, and protected PDFs keep their opening password.

The browser renders each selected scan using PDF.js. The selected local engine
recognizes the text; the backend places an invisible text layer over the original page,
respecting rotation, crop boxes and page scaling. Original images, page
sizes, bookmarks, forms and other PDF objects are preserved. OCR keeps the
page's visible content; optional automatic rotation changes only its viewing
orientation, without resampling the original image. Recognition is best for
printed text; it can misread characters, columns and handwriting. Review the
extracted text before relying on it. OCR does not redact content, deskew
scans or replace existing OCR text.

The Tesseract option requires **Tesseract 4 or newer** and its language data on
the backend computer. Other tools continue to work without it. The OCR tab reports
missing dependencies and offers **Check again** after installation:

- macOS: `brew install tesseract` includes English. For additional languages,
  use `brew install tesseract-lang`.
- Debian/Ubuntu: `sudo apt install tesseract-ocr tesseract-ocr-eng`.
  Add language packages such as `tesseract-ocr-fra` as needed, and
  `tesseract-ocr-osd` for automatic rotation.
- Windows: install Tesseract using the options in the
  [official installation guide](https://tesseract-ocr.github.io/tessdoc/Installation.html)
  and add its executable directory to `PATH`.

Set `PDFER_TESSERACT` to the executable's absolute path if it is not on
`PATH`. `TESSDATA_PREFIX` can select a custom language-data directory.
Installed Tesseract languages are detected locally.

To install the optional Paddle engine, run this once from the project folder:

```bash
pnpm ocr:paddle:setup
```

This explicitly downloads a separate Python 3.12 environment, its locked
PaddleOCR 3.7 dependencies, and pinned revisions of the official
`PP-OCRv6_medium_det` and `PP-OCRv6_medium_rec` models from PaddlePaddle on
Hugging Face. It checks real local CPU inference before reporting success.
Normal `pnpm install` does not install this optional environment or download
models. Tesseract and the Python 3.14 backend keep their existing dependencies.

The environment lives in `backend/ocr-runtime/.venv/`; model files and runtime
cache live in `backend/ocr-runtime/models/`. Both are ignored by Git. Run the
setup command in a new checkout before selecting Paddle there. Use **Check
again** in the OCR tab after setup. `PDFER_PADDLE_PYTHON` can point to a compatible
external Python executable; `PDFER_PADDLE_MODELS` can select a model folder
containing both named model directories. Setup honors that model folder too.

Paddle uses the medium models for Chinese, English, Japanese and their supported
Latin-script languages. It does not use Tesseract language codes or load other
model generations as a fallback. The worker uses CPU inference, explicit local
model paths and disabled model-host connectivity checks; recognition never
downloads models or calls an external OCR service. The medium models require
more memory and load anew for each page so cancellation can stop the process.
Word polygons become an invisible Unicode PDF font layer, supporting recognized
scripts without requiring extra display fonts. Text remains approximate OCR
and should be reviewed; engine selection does not guarantee higher accuracy.

Recognition uses private temporary
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

### PDF compression and target sizes

Drop or choose several PDFs in **Compress**, then choose Light, Balanced or
Strong. Add more PDFs to the current batch or remove individual files before
running it. Each row shows its original and compressed size, bytes saved,
and percentage saved. PDFs that do not get smaller are included unchanged.
Duplicate output filenames are made unique so every input stays in the ZIP.

Enable **Fit each PDF to a target size** to request, for example, at most
**2 MB** per PDF. Targets use decimal units: 1 KB = 1,000 bytes and 1 MB =
1,000,000 bytes; the allowed range is 1 KB–500 MB, in whole bytes. The target
replaces the preset level while enabled. Each row shows the measured result
size, target and whether it was met. Inputs already within the limit keep
their exact original bytes. If the target cannot be reached, the smallest
result found within the quality floor is offered with **Target not met**.
Text-only PDFs and images that cannot safely be recompressed may have little
or no size reduction. The limit applies to each PDF, not to the ZIP archive.

Review the actual result with page navigation, **Original** / **Result**
switching or **Side by side** comparison. A batch has a PDF selector and
individual downloads/tool handoff as well as **Download ZIP**. Downloads
reuse the exact preview files; they do not rerun compression. Results are
offered for download after the selected result page renders successfully.

Compression runs one PDF at a time with per-file progress and cancellation.
Protected inputs prompt for their own passwords, and each resulting PDF
keeps that password. A cancelled password prompt can be retried from its row.
Unreadable inputs must be removed or reopened before starting the batch.

Several PDFs produce **Download ZIP**; a single PDF keeps the existing direct
download and tool handoff options. Combined savings describe the PDFs inside
the archive; the ZIP's own size is shown separately. No download starts
automatically, and a failed or cancelled batch never offers a partial ZIP.
Changing the level, target or units, or adding/removing inputs cancels any active batch and
clears outdated results. For very large archives, split the inputs into
smaller batches. Cancellation stops the server search between images and
candidate rewrites; a native image encode or PDF save already in progress
finishes before it can stop. Cancelled or superseded results are discarded.

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
pack are installed, plus automatic-rotation integration tests when `osd` is
available. Paddle integration tests run when its optional setup is complete,
including rotation through local Tesseract orientation detection. Native tests
are skipped when their required engine or language packs are missing. The
test-only pypdfium2 dependency verifies rendered pixels and text placement,
including encrypted, cropped, scaled and rotated pages. Process
cancellation, page geometry, password retention and visual-preservation tests
run without Tesseract. The app itself does not need pypdfium2 or OCRmyPDF.

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
  src/pdfer/metadata.py  targeted XMP/DocumentInfo edits and explicit document-metadata clearing
  src/pdfer/redactions.py image-only PDF rebuilding from masked pixels
  src/pdfer/ocr.py       local OCR process dispatch, rotation and invisible text-layer assembly
  src/pdfer/paddle_ocr.py optional PP-OCRv6 runtime discovery
  src/pdfer/ocr_text.py  invisible Unicode PDF layers from recognized word positions
  ocr-runtime/          isolated optional PaddleOCR environment and explicit model setup
  src/pdfer/fonts/       DejaVu Sans, Serif and Sans Mono; add .ttf files here for more scripts
  src/pdfer/api.py       HTTP endpoints; also serves frontend/dist if built
  tests/
frontend/                Vite, React, TypeScript, Tailwind
  src/components/        MergeTool, SplitTool, OrganizeTool (+ PdfCropEditor), BookmarksTool, MetadataTool, FormsTool, RedactTool (+ RedactionPage), PdfToolPreview, TextTool (+ TextPage), CompareTool (+ ComparePreview), WorkflowTool (+ WorkflowSteps, WorkflowResults), ProjectsPanel, ProjectControls, EditTool (+ EditPage), SignatureTool (+ SignatureCreator), StampTool (+ DocumentPreview), CompressTool, PdfImagesTool, PasswordTool (+ PdfPasswordDialog), ImagesTool, PhotoTool (+ PhotoCropper), Dropzone, PageThumbnail, ResultCard
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
PDF comparison uses that same parser and renderer, with bounded sequential
pixel comparison and literal text diffs in `frontend/src/lib/pdfCompare.ts`.
Its tests render real PDF fixtures (including scans, invisible text, different
stream encodings, geometry changes and independent encrypted inputs), using
PDF.js's existing optional canvas dependency for Node tests; the app uses the
browser canvas. Lifecycle tests cover cancellation, replacement and stale results.
Workflows compose the existing stamp, compress and protect endpoints. Presets
use a validated, versioned browser-storage record; run credentials are kept
separate. Results are packaged locally with `fflate` after every file succeeds.

## API

| Endpoint | Form fields | Returns |
|---|---|---|
| `GET /api/ocr/status` | optional query `engine=tesseract\|paddleocr` (default `tesseract`) | selected engine availability, recognition languages and `can_rotate` |
| `POST /api/ocr/page` | `image` (PNG), `languages` (`eng+fra` for Tesseract or `auto` for Paddle), `dpi` (150 or 300), optional `rotate` (default false), `engine` (default `tesseract`) | an invisible, one-page PDF text layer and `X-OCR-Rotation` (clockwise correction) |
| `POST /api/ocr/assemble` | `file`, `layers` (PDF text layers), `pages` (JSON page-number list), optional `password`, `rotations` (aligned JSON list of 0/90/180/270, default all zero) | `<name>_searchable.pdf`, preserving original content and password with the requested page rotations |
| `POST /api/merge` | `files` (2 or more, in order), optional `passwords` | `merged.pdf` |
| `POST /api/split` | `file`, `mode`, `ranges`, optional `password` | a PDF, or a zip if there are several outputs |
| `POST /api/organize` | `file`, `pages`, optional `layout` (JSON), optional `password` | `<name>_organized.pdf`, used for preview and download |
| `POST /api/forms/read` | `file`, optional `password` | field IDs, values, types, options, page locations and read-only/signature status |
| `POST /api/forms/fill` | `file`, `values` (JSON object keyed by field ID), optional `flatten` (default false), optional `password` | `<name>_filled.pdf` |
| `POST /api/bookmarks/read` | `file`, optional `password` | bookmark titles, source IDs, destination pages and nesting levels |
| `POST /api/bookmarks` | `file`, `entries` (JSON array), optional `password` | `<name>_bookmarks.pdf` |
| `POST /api/metadata/read` | `file`, optional `password` | XMP and DocumentInfo values, conflicts, read-only fields, store presence and editability warnings |
| `POST /api/metadata` | `file`, optional `changes` (JSON object: omitted field = keep, string = edit, null = clear), `clear` (default false), `password` | `<name>_metadata.pdf`; `clear=true` removes both document metadata stores and cannot be combined with field edits |
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
| `POST /api/compress` | `file`, `level`, optional `password`, optional `max_bytes` (integer, 1,000–500,000,000) | `<name>_compressed.pdf`, with measured `X-Original-Size` and `X-Compressed-Size`; target requests also return `X-Target-Size` and `X-Target-Met` (`true`/`false`) |
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

`edits` is a JSON list of overlays or region moves, each with a `type`
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
- `region`: `sourcePage` identifies the original 1-based source page, and
  `source` (`x`, `y`, `width`, `height`) identifies its rectangle. The edit's
  `page` is the destination page; `x`, `y`, `width`, `height` identify its
  destination rectangle. Omitting `sourcePage` uses `page` for compatibility
  with older same-page clients. Region coordinates are physical display points, including
  `/UserUnit` scaling. Both rectangles must fit inside their respective visible pages and
  measure at least 2 points in each dimension. Move/deletion sources cannot overlap.
  Source and destination rectangles cannot touch annotations, links or form fields.
  Optional `copy: true` places a cutout without covering its source; copies may
  share source rectangles with any other region. Omitted or false `copy` keeps
  the normal move behavior. Move/deletion source areas are covered with white first,
  then overlays and clipped regions are painted in list order. The original
  content is retained; this operation does not securely remove it. Optional
  `deleted: true` covers only the source and omits the cutout at its destination;
  the unused destination rectangle is not checked against page bounds or
  annotations. The destination fields remain in the payload to keep the same
  region format. Omitting `deleted` or setting it to `false` keeps a normal move.
  `copy` and `deleted` cannot both be true; delete a copy by removing its edit.
  Optional `rotation` is clockwise 0 (default), 90, 180 or 270 degrees relative
  to the original displayed crop. The destination `width` and `height` describe
  the visible box after rotation. The source rectangle and page never rotate.
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

For `/api/compress`, optional `max_bytes` overrides the preset with a bounded,
deterministic search: a lossless rewrite, then longest-image-side/JPEG-quality
pairs **2400/90, 2000/85, 1600/75, 1200/65, 1000/60, 800/50**. Every candidate
starts from the original input to avoid cumulative JPEG loss. The first
candidate at or below the target wins; if none fits, the smallest measured
candidate (including the original) wins. This is a fixed quality ladder, not
a guarantee of the mathematically optimal encoding. It never rasterizes
whole pages, deletes pages or strips text to satisfy a limit. Text, vector
content, page boxes and rotation remain intact. Target mode can compress RGB
and grayscale images with ordinary 8-bit soft transparency masks: colour is
encoded as JPEG, alpha is encoded losslessly, and both are resized together when
needed. Resized masks are copied so shared originals stay intact, and colour
profiles are retained. Complex masks (including colour-key masks and matte
preblending), indexed colour, CMYK or unsupported encodings are kept; inline
and annotation/pattern images are left alone. Preset levels continue to leave
masked images alone. The existing `level` calls, including workflows, work
unchanged when `max_bytes` is omitted. Encrypted PDFs keep their opening
password, and their measured result includes encryption overhead.

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
