"""Prepare self-contained native resources before electron-builder runs."""

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESOURCES = ROOT / "desktop/resources"


def find_tessdata(executable: Path, report: str, *, env=None, prefixes=None) -> Path:
    env = os.environ if env is None else env
    configured = env.get("PDFER_BUILD_TESSDATA") or env.get("TESSDATA_PREFIX")
    if configured:
        candidates = [Path(configured)]
    else:
        # Recent Tesseract prints its data directory; older Linux builds only
        # print the language count. Also support installation-relative layouts.
        candidates = [Path(value) for value in re.findall(r'"([^"\n]+)"', report)]
        candidates.append(executable.resolve().parent / "tessdata")
        roots = prefixes if prefixes is not None else [executable.resolve().parent.parent, executable.parent.parent, Path("/usr")]
        for prefix in roots:
            candidates.append(prefix / "share/tessdata")
            candidates.extend(sorted((prefix / "share/tesseract-ocr").glob("*/tessdata")))
    for candidate in candidates:
        if all((candidate / name).is_file() for name in ("eng.traineddata", "osd.traineddata")):
            return candidate.resolve()
    raise SystemExit("English and orientation data are required. Set PDFER_BUILD_TESSDATA to the folder containing eng.traineddata and osd.traineddata.")


def main():
    tesseract = Path(os.environ.get("PDFER_BUILD_TESSERACT") or shutil.which("tesseract") or "")
    if not tesseract.is_file():
        raise SystemExit("Install Tesseract on the build machine, or set PDFER_BUILD_TESSERACT.")
    report = subprocess.check_output([str(tesseract), "--list-langs"], text=True)
    tessdata = find_tessdata(tesseract, report)
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
