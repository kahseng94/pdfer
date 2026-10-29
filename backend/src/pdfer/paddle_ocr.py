"""Discover the optional PP-OCRv6 worker without importing its dependencies."""

import json
import os
import subprocess
from pathlib import Path

RUNTIME = Path(__file__).resolve().parents[2] / "ocr-runtime"
SETUP = "Run pnpm ocr:paddle:setup from the project folder, then check again."


def python() -> Path:
    configured = os.environ.get("PDFER_PADDLE_PYTHON")
    return Path(configured).expanduser() if configured else RUNTIME / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def models() -> Path:
    return Path(os.environ.get("PDFER_PADDLE_MODELS", RUNTIME / "models")).expanduser().resolve()


def command() -> list[str]:
    return [str(python()), str(RUNTIME / "worker.py"), "--models", str(models())]


def status() -> dict:
    unavailable = {"available": False, "languages": [], "message": "PaddleOCR PP-OCRv6 is not set up. " + SETUP}
    if not python().is_file() or not (RUNTIME / "worker.py").is_file():
        return unavailable
    try:
        process = subprocess.run([*command(), "--status"], capture_output=True, text=True, timeout=10)
        value = json.loads(process.stdout)
        if process.returncode or not isinstance(value, dict) or type(value.get("available")) is not bool:
            return unavailable
        return {"available": value["available"], "languages": ["auto"] if value["available"] else [],
                "message": None if value["available"] else str(value.get("message") or unavailable["message"])}
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return unavailable
