"""Explicit one-time download of the official PP-OCRv6 medium models."""

import json
import os
import tempfile
from pathlib import Path

from huggingface_hub import snapshot_download
from PIL import Image, ImageDraw

from worker import MODELS, model_root, recognize

REVISIONS = {
    "PP-OCRv6_medium_det": "8e0f56fb2ef86b461d99cfc7ac5c137738985f61",
    "PP-OCRv6_medium_rec": "e5a92bcbc5cc1b494628e458d267778f0704fd7c",
}


def main():
    root = model_root()
    root.mkdir(parents=True, exist_ok=True)
    revisions = {}
    for model in MODELS:
        repository = f"PaddlePaddle/{model}"
        revision = REVISIONS[model]
        print(f"Downloading {repository} ({revision})", flush=True)
        snapshot_download(repository, revision=revision, local_dir=root / model,
                          allow_patterns=["inference.json", "inference.pdiparams", "inference.yml"])
        revisions[model] = revision
    # Verify an actual local prediction before reporting that setup succeeded.
    print("Checking local CPU inference…", flush=True)
    with tempfile.TemporaryDirectory(prefix="pdfer-paddle-check-") as folder:
        image = Image.new("RGB", (800, 160), "white")
        ImageDraw.Draw(image).text((30, 40), "LOCAL OCR CHECK 12345", fill="black", font_size=40)
        path = Path(folder) / "check.png"
        image.save(path)
        result = recognize(path, root)
        if not result["words"]:
            raise RuntimeError("The models loaded but did not recognize the setup image.")
    (root / "manifest.json").write_text(json.dumps({"models": revisions}, indent=2) + "\n", encoding="utf-8")
    print("PaddleOCR PP-OCRv6 medium is ready. Select it in the OCR tab.", flush=True)


if __name__ == "__main__":
    os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    main()
