"""Retain installed package notices for the components bundled by PyInstaller."""
import importlib.metadata
import os
import subprocess
import sys
from pathlib import Path


def license_files(binaries):
    found = {}
    def add(path, directory):
        if path.is_file():
            found[str(path)] = directory
    for dist in importlib.metadata.distributions():
        name = dist.metadata.get("Name", "package")
        for entry in dist.files or []:
            if entry.name.upper().startswith(("LICENSE", "COPYING", "NOTICE")):
                add(Path(dist.locate_file(entry)), f"licenses/python/{name}-{dist.version}")
    for name in ("LICENSE", "LICENSE.txt", "LICENSE.rst"):
        add(Path(sys.base_prefix) / name, "licenses/python/CPython")
    sources = [Path(source).resolve() for _, source, _ in binaries]
    for source in sources:
        # Homebrew keeps upstream notices at the formula's installed prefix.
        if "Cellar" in source.parts:
            index = source.parts.index("Cellar")
            prefix = Path(*source.parts[:index + 3])
            for pattern in ("LICENSE*", "COPYING*", "NOTICE*", "share/doc/**/LICENSE*", "share/doc/**/COPYING*", "share/doc/**/NOTICE*"):
                for notice in prefix.glob(pattern):
                    add(notice, f"licenses/native/{prefix.parent.name}")
        elif sys.platform == "linux" and source.is_file():
            result = subprocess.run(["dpkg-query", "-S", str(source)], capture_output=True, text=True)
            if result.returncode == 0:
                package = result.stdout.split(": ")[0].split(":")[0]
                add(Path("/usr/share/doc") / package / "copyright", f"licenses/native/{package}")
        elif os.name == "nt":
            for pattern in ("LICENSE*", "COPYING*", "NOTICE*"):
                for notice in source.parent.glob(pattern):
                    add(notice, "licenses/native/" + source.parent.name)
    return [(source, directory) for source, directory in found.items()]
