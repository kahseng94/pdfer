"""Optional PP-OCRv6 process. No pdfer imports: this runs in its own Python env."""

import argparse
import importlib.metadata
import json
import os
from pathlib import Path

MODELS = ("PP-OCRv6_medium_det", "PP-OCRv6_medium_rec")
SETUP = "Run pnpm ocr:paddle:setup from the project folder, then check again."


def model_root() -> Path:
    return Path(os.environ.get("PDFER_PADDLE_MODELS", Path(__file__).with_name("models"))).expanduser().resolve()


def status(root: Path) -> dict:
    try:
        version = importlib.metadata.version("paddleocr")
        importlib.metadata.version("paddlepaddle")
        if tuple(int(part) for part in version.split(".")[:2]) != (3, 7):
            return {"available": False, "languages": [], "message": "This integration needs PaddleOCR 3.7. " + SETUP}
    except (importlib.metadata.PackageNotFoundError, ValueError):
        return {"available": False, "languages": [], "message": "The optional PaddleOCR runtime is missing. " + SETUP}
    for model in MODELS:
        if any(not (root / model / name).is_file() or (root / model / name).stat().st_size == 0
               for name in ("inference.json", "inference.pdiparams", "inference.yml")):
            return {"available": False, "languages": [], "message": "PP-OCRv6 medium model files are missing. " + SETUP}
        # Reject accidentally supplied v5 or other weights instead of relabeling them.
        import yaml
        with (root / model / "inference.yml").open(encoding="utf-8") as file:
            config = yaml.safe_load(file)
        if not isinstance(config, dict) or config.get("Global", {}).get("model_name") != model:
            return {"available": False, "languages": [], "message": "The configured models are not PP-OCRv6 medium. " + SETUP}
    return {"available": True, "languages": ["auto"], "message": None}


def pipeline(root: Path):
    # Every model path is explicit. Detection must never fetch models or use a service.
    os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(root / ".runtime-cache"))
    from paddleocr import PaddleOCR
    return PaddleOCR(
        device="cpu", cpu_threads=2, enable_mkldnn=False,
        text_detection_model_name=MODELS[0], text_detection_model_dir=str(root / MODELS[0]),
        text_recognition_model_name=MODELS[1], text_recognition_model_dir=str(root / MODELS[1]),
        use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False,
        return_word_box=True,
    )


def word_regions(result) -> list[dict]:
    """Keep punctuation and CJK characters together when the model has no space."""
    words = []
    texts, regions, lines = result["text_word"], result["text_word_region"], result["rec_texts"]
    if not len(texts) == len(regions) == len(lines) == len(result["rec_polys"]):
        raise RuntimeError("PaddleOCR returned inconsistent word positions.")
    for line, (line_words, line_regions, line_text) in enumerate(zip(texts, regions, lines)):
        if len(line_words) != len(line_regions):
            raise RuntimeError("PaddleOCR returned inconsistent word positions.")
        grouped = []
        cursor = 0
        for text, points in zip(line_words, line_regions):
            if not text.strip():
                continue
            start = line_text.find(text, cursor)
            if start < 0 or line_text[cursor:start].strip():
                grouped = []
                break
            polygon = [[float(x), float(y)] for x, y in points]
            if grouped and start == cursor:
                previous = grouped[-1]
                previous["text"] += text
                previous["polygon"] = [previous["polygon"][0], polygon[1], polygon[2], previous["polygon"][3]]
            else:
                grouped.append({"text": text, "polygon": polygon, "line": line})
            cursor = start + len(text)
        if (not grouped or line_text[cursor:].strip()) and line_text.strip():
            # A decoder may omit a token from its word output. Preserve its full
            # recognized line rather than silently dropping that text.
            grouped = [{"text": line_text, "polygon": [[float(x), float(y)] for x, y in result["rec_polys"][line]], "line": line}]
        words.extend(grouped)
    return words


def recognize(image: Path, root: Path) -> dict:
    readiness = status(root)
    if not readiness["available"]:
        raise RuntimeError(readiness["message"])
    from PIL import Image
    with Image.open(image) as source:
        width, height = source.size
    result = pipeline(root).predict(str(image))[0]
    return {"width": width, "height": height, "words": word_regions(result)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--models", type=Path, default=model_root())
    parser.add_argument("--image", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.status:
        try:
            value = status(args.models)
        except Exception:
            value = {"available": False, "languages": [], "message": "The PaddleOCR installation needs repair. " + SETUP}
        print(json.dumps(value))
    elif args.image and args.output:
        output = recognize(args.image, args.models)
        args.output.write_text(json.dumps(output, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    else:
        parser.error("Provide --status or --image and --output.")


if __name__ == "__main__":
    main()
