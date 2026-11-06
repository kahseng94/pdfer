# Build on each target OS/architecture. Native dependencies are never cross-built.
import os
import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, copy_metadata

root = Path(SPECPATH).parent
sys.path.insert(0, str(root / "desktop"))
from collect_licenses import license_files
tesseract = Path(os.environ["PDFER_BUILD_TESSERACT"])
tessdata = Path(os.environ["PDFER_BUILD_TESSDATA"])
datas = collect_data_files("pdfer", includes=["fonts/*"])
for name in ("eng.traineddata", "osd.traineddata"):
    datas.append((str(tessdata / name), "tessdata"))
for name in ("configs", "tessconfigs"):
    if (tessdata / name).is_dir():
        datas.append((str(tessdata / name), "tessdata/" + name))
for package in ("pikepdf", "Pillow", "fonttools", "img2pdf", "fastapi", "uvicorn"):
    datas += copy_metadata(package)
binaries = [(str(tesseract), "ocr")]
if os.name == "nt":
    binaries += [(str(path), "ocr") for path in tesseract.parent.glob("*.dll")]

a = Analysis([str(root / "desktop/backend_entry.py")], pathex=[str(root / "backend/src")],
             binaries=binaries, datas=datas,
             hiddenimports=["uvicorn.logging", "uvicorn.loops.asyncio", "uvicorn.protocols.http.h11_impl",
                            "uvicorn.lifespan.on"],
             excludes=["pytest", "pypdfium2", "tkinter"], noarchive=False)
a.datas += [(str(Path(destination) / Path(source).name), source, "DATA") for source, destination in license_files(a.binaries)]
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="pdfer-backend", console=True,
          debug=False, strip=False, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="pdfer-backend")
