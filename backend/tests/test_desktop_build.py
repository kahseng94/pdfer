import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("pdfer_desktop_build", Path(__file__).resolve().parents[2] / "desktop/build_backend.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


def language_data(path):
    path.mkdir(parents=True)
    for name in ("eng.traineddata", "osd.traineddata"):
        (path / name).write_bytes(b"fixture")
    return path


def test_old_linux_tesseract_output_discovers_versioned_language_directory(tmp_path):
    data = language_data(tmp_path / "share/tesseract-ocr/4.00/tessdata")
    assert build.find_tessdata(tmp_path / "bin/tesseract", "List of available languages (2):\neng\nosd\n", env={}, prefixes=[tmp_path]) == data


def test_language_path_report_and_windows_installation_layout(tmp_path):
    data = language_data(tmp_path / "Tesseract OCR/tessdata")
    assert build.find_tessdata(tmp_path / "bin/tesseract", f'List of available languages in "{data}" (2):\neng\nosd\n', env={}, prefixes=[]) == data
    assert build.find_tessdata(data.parent / "tesseract.exe", "List of available languages (2):", env={}, prefixes=[]) == data


def test_missing_or_explicitly_incomplete_data_fails_with_configuration_help(tmp_path):
    language_data(tmp_path / "share/tessdata")
    with pytest.raises(SystemExit, match="PDFER_BUILD_TESSDATA"):
        build.find_tessdata(tmp_path / "bin/tesseract", "", env={"PDFER_BUILD_TESSDATA": str(tmp_path / "missing")}, prefixes=[tmp_path])
