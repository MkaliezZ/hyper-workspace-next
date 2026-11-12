"""Fetch the locked official client package; no package-manager installation."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile
import urllib.request

ADDITIONS = {"libpython3.14.so", "libpython3.14.so.1.0", "libpython3.14.so.1.0-gdb.py",
             "libpythonloaderlo.so", "libpyuno.so", "officehelper.py", "python", "python.bin",
             "python-core-3.14.10", "pythonloader.py", "pythonloader.unorc", "pyuno.so", "uno.py", "unohelper.py"}


def extract(data, output):
    (output / "licenses").mkdir(parents=True, exist_ok=True)
    if data[:8] != b"!<arch>\n":
        raise ValueError("Invalid locked package")
    position, payload = 8, None
    while position + 60 <= len(data):
        header = data[position:position+60]
        name = header[:16].decode().strip().rstrip("/")
        size = int(header[48:58])
        position += 60
        if name.startswith("data.tar"):
            payload = data[position:position+size]
        position += size + size % 2
    if payload is None:
        raise ValueError("Missing package payload")
    with tarfile.open(fileobj=io.BytesIO(payload)) as archive:
        members = []
        for member in archive.getmembers():
            path = PurePosixPath(member.name.removeprefix("./"))
            if path.is_absolute() or ".." in path.parts:
                raise ValueError("Unsafe package path")
            if member.isdir():
                continue
            prefix = "opt/collaboraoffice/program/"
            relative = str(path).removeprefix(prefix)
            if str(path).startswith(prefix):
                first = relative.split("/")[0]
                if first not in ADDITIONS and relative != "services/pyuno.rdb":
                    raise ValueError("Unexpected client overlay file")
            elif str(path) != "opt/collaboraoffice/collaboraofficebasis-pyuno-sbom.spdx.json":
                # Preserve package notices, but never overlay unrelated image paths.
                member.name = "licenses/package/" + str(path)
            members.append(member)
        archive.extractall(output, members=members, filter="data")


def main():
    lock = json.loads(Path(__file__).with_name("runtime.lock.json").read_text())["pyuno"]
    # Optional local cache is still hash/size verified, never a URL override.
    if len(sys.argv) == 3:
        data = Path(sys.argv[2]).read_bytes()
    else:
        with urllib.request.urlopen(lock["url"], timeout=60) as source:
            data = source.read(lock["size"] + 1)
    if len(data) != lock["size"] or hashlib.sha256(data).hexdigest() != lock["sha256"]:
        raise ValueError("Locked package integrity mismatch")
    extract(data, Path(sys.argv[1]))
    print("Verified official pyuno " + lock["version"])


if __name__ == "__main__":
    main()
