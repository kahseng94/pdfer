# pdfer

Merge, split, organize, edit, compress and protect PDFs, export PDF pages as images, compress images or turn them into a PDF, or crop a passport photo, on your own computer.
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

Only saved signature images and their names are persisted; open PDFs and
placements stay in the browser session. The library is a private SQLite
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
  src/pdfer/fonts/       DejaVu Sans, Serif and Sans Mono; add .ttf files here for more scripts
  src/pdfer/api.py       HTTP endpoints; also serves frontend/dist if built
  tests/
frontend/                Vite, React, TypeScript, Tailwind
  src/components/        MergeTool, SplitTool, OrganizeTool, EditTool (+ EditPage), SignatureTool (+ SignatureCreator), StampTool (+ DocumentPreview), CompressTool, PdfImagesTool, PasswordTool (+ PdfPasswordDialog), ImagesTool, PhotoTool (+ PhotoCropper), Dropzone, PageThumbnail, ResultCard
  src/lib/               API client, the tool list and passing results between tools, pdf.js previews and image export, ZIP packaging, range helpers, edit elements and geometry, fonts, passport photo sizes and crop geometry
```

New PDF features go in `core.py` first, then get an endpoint in `api.py`.
PDF-to-image export uses the existing pdf.js renderer in the browser and
`fflate` for ZIP packaging, so it needs no backend endpoint or native renderer.
Batch PDF compression calls the existing `/api/compress` endpoint sequentially,
with each file's password, and packages the returned PDFs locally with `fflate`.

## API

| Endpoint | Form fields | Returns |
|---|---|---|
| `POST /api/merge` | `files` (2 or more, in order), optional `passwords` | `merged.pdf` |
| `POST /api/split` | `file`, `mode`, `ranges`, optional `password` | a PDF, or a zip if there are several outputs |
| `POST /api/organize` | `file`, `pages`, optional `layout` (JSON), optional `password` | `<name>_organized.pdf`, used for preview and download |
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
