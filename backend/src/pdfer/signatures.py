"""The user's local signature-image library, kept independently of browser storage."""

import os
import sqlite3
import sys
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from pdfer.core import PdfToolError, SignatureImage


class StoreError(Exception):
    """An unavailable local library, without exposing filesystem details."""


def library_path() -> Path:
    configured = os.environ.get("PDFER_DATA_DIR")
    if configured:
        base = Path(configured).expanduser()
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "pdfer"
    elif os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "pdfer"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "pdfer"
    return base.resolve() / "signatures" / "library.sqlite3"


@contextmanager
def _connection(*, write: bool = False):
    path = library_path()
    connection = None
    try:
        if not write and not path.is_file():
            yield None
            return
        if write:
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            path.parent.chmod(0o700)
            connection = sqlite3.connect(path, timeout=5)
            path.chmod(0o600)
            connection.execute("PRAGMA secure_delete = ON")
            connection.execute("CREATE TABLE IF NOT EXISTS signatures (id TEXT PRIMARY KEY, name TEXT NOT NULL, image BLOB NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, created_at TEXT NOT NULL)")
        else:
            connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)
        connection.row_factory = sqlite3.Row
        with connection:
            yield connection
    except (OSError, sqlite3.Error):
        raise StoreError("The local signature library is unavailable. Check that pdfer can access its data folder.") from None
    finally:
        if connection is not None:
            connection.close()


def validate_name(name: str) -> str:
    name = name.strip()
    if not name or len(name) > 80 or any(ord(char) < 32 or ord(char) == 127 for char in name):
        raise PdfToolError("Give the signature a name of 1–80 characters without control characters.")
    return name


def list_signatures() -> list[dict]:
    with _connection() as connection:
        if connection is None:
            return []
        return [dict(row) for row in connection.execute("SELECT id, name, width, height, created_at FROM signatures ORDER BY created_at DESC, id")]


def save_signature(name: str, image: SignatureImage) -> dict:
    metadata = dict(id=uuid.uuid4().hex, name=validate_name(name), width=image.width, height=image.height, created_at=datetime.now(timezone.utc).isoformat())
    with _connection(write=True) as connection:
        connection.execute("INSERT INTO signatures (id, name, image, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                           (metadata["id"], metadata["name"], image.data, image.width, image.height, metadata["created_at"]))
    return metadata


def read_signature(identifier: str) -> bytes | None:
    with _connection() as connection:
        if connection is None:
            return None
        row = connection.execute("SELECT image FROM signatures WHERE id = ?", (identifier,)).fetchone()
        return bytes(row["image"]) if row else None


def delete_signature(identifier: str) -> bool:
    if not library_path().is_file():
        return False
    with _connection(write=True) as connection:
        return connection.execute("DELETE FROM signatures WHERE id = ?", (identifier,)).rowcount > 0
