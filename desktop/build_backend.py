"""Prepare self-contained native resources before electron-builder runs."""

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESOURCES = ROOT / "desktop/resources"


def main():
    tesseract = Path(os.environ.get("PDFER_BUILD_TESSERACT") or shutil.which("tesseract") or "")
    if not tesseract.is_file():
        raise SystemExit("Install Tesseract on the build machine, or set PDFER_BUILD_TESSERACT.")
    configured = os.environ.get("PDFER_BUILD_TESSDATA") or os.environ.get("TESSDATA_PREFIX")
    if configured:
        tessdata = Path(configured)
    else:
        # --list-langs prints the configured data directory on every supported OS.
        first_line = subprocess.check_output([str(tesseract), "--list-langs"], text=True).splitlines()[0]
        tessdata = Path(first_line.split('"')[1])
    if any(not (tessdata / name).is_file() for name in ("eng.traineddata", "osd.traineddata")):
        raise SystemExit(f"English and orientation data are required in {tessdata}.")
    uv = shutil.which("uv")
    if not uv:
        raise SystemExit("uv is required on the build machine to bundle optional OCR setup.")
    RESOURCES.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "PDFER_BUILD_TESSERACT": str(tesseract.resolve()),
           "PDFER_BUILD_TESSDATA": str(tessdata.resolve()), "PYINSTALLER_CONFIG_DIR": str(ROOT / "desktop/build/cache")}
    subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
                    "--distpath", str(RESOURCES), "--workpath", str(ROOT / "desktop/build/pyinstaller"),
                    str(ROOT / "desktop/backend.spec")], env=env, cwd=ROOT, check=True)
    tools = RESOURCES / "tools"
    tools.mkdir(exist_ok=True)
    shutil.copy2(uv, tools / ("uv.exe" if os.name == "nt" else "uv"))
    runtime = RESOURCES / "ocr-runtime"
    runtime.mkdir(exist_ok=True)
    for name in ("pyproject.toml", "uv.lock", "worker.py", "setup_models.py"):
        shutil.copy2(ROOT / "backend/ocr-runtime" / name, runtime / name)
    subprocess.run([sys.executable, str(ROOT / "desktop/create_icons.py")], check=True)
    print(f"Desktop resources prepared in {RESOURCES}")


if __name__ == "__main__":
    main()
