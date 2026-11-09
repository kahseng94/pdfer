# Desktop runtime components

macOS builds include Sparkle (permissive license) and its license notices inside
Sparkle.framework. The pinned version and archive checksum are in
`desktop/sparkle/version.json`. Source: https://github.com/sparkle-project/Sparkle.
The native bridge is compiled against Node-API headers (MIT).

pdfer bundles Electron (MIT), electron-updater (MIT), CPython (PSF), and its
Python dependencies, including openpyxl and et-xmlfile (MIT) for spreadsheets.
Electron includes its LICENSE and LICENSES.chromium.html.
Python package metadata and bundled DejaVu font licensing are retained with the
backend. See the source distributions for each component's complete notices.

HEIC and HEIF photos are read with pi-heif (BSD-3-Clause), the decode-only
build of pillow-heif, whose wheels bundle libheif (LGPL-3.0) and the libde265
HEVC decoder (LGPL-3.0) and no encoder. pdfer only decodes HEIC and never
writes it. The package's own notices (LICENSE.txt and LICENSES_bundled.txt)
are retained with the backend under `licenses/python`.

- https://github.com/bigcat88/pillow_heif/blob/master/LICENSE.txt
- https://github.com/strukturag/libheif/blob/master/COPYING
- https://github.com/strukturag/libde265/blob/master/COPYING

The desktop OCR engine is Tesseract (Apache-2.0) and includes the English and
orientation trained data. Tesseract also uses Leptonica (BSD-2-Clause) and the
image libraries supplied by the build platform.

- https://github.com/tesseract-ocr/tesseract/blob/main/LICENSE
- https://github.com/tesseract-ocr/tessdata_fast/blob/main/LICENSE
- https://github.com/DanBloomberg/leptonica/blob/master/leptonica-license.txt

The optional local OCR installer bundles uv (MIT OR Apache-2.0):
https://github.com/astral-sh/uv/tree/main

PaddleOCR, PaddlePaddle, their dependencies, and pinned PP-OCRv6 model files are
downloaded only when the user chooses Install PaddleOCR. Their license metadata
is retained in the local OCR environment.
