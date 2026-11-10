"""Prepare the pinned Nextcloud Office connector without changing a running server."""
import hashlib
import json
from pathlib import Path
import tarfile
import tempfile
import urllib.request
import xml.etree.ElementTree as ET

location = Path(__file__).resolve().parent
lock = json.loads((location / "office.lock.json").read_text())
output = location.parents[1] / ".runtime" / "nextcloud"
output.mkdir(parents=True, exist_ok=True)
archive = output / f"richdocuments-v{lock['version']}.tar.gz"
prepared = output / "richdocuments"


def verify_manifest(manifest):
    dependency = manifest.find("dependencies/nextcloud")
    major = lock["serverMajor"]
    if (manifest.findtext("id") != "richdocuments"
            or manifest.findtext("version") != lock["version"]
            or dependency is None
            or dependency.get("min-version") != major
            or dependency.get("max-version") != major):
        raise RuntimeError("Office connector version or Nextcloud compatibility mismatch")


def verify_archive(path):
    with path.open("rb") as stream:
        if path.stat().st_size != lock["size"] or hashlib.file_digest(stream, "sha256").hexdigest() != lock["sha256"]:
            raise RuntimeError("Office connector archive integrity check failed")


if not archive.exists():
    with tempfile.TemporaryDirectory(dir=output) as scratch:
        partial = Path(scratch) / archive.name
        request = urllib.request.Request(lock["archive"], headers={"User-Agent": "Hyper-Workspace"})
        with urllib.request.urlopen(request, timeout=60) as response, partial.open("wb") as stream:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > lock["size"]:
                    raise RuntimeError("Office connector archive exceeds pinned size")
                stream.write(chunk)
        verify_archive(partial)
        partial.replace(archive)

verify_archive(archive)
if not prepared.exists():
    with tempfile.TemporaryDirectory(dir=output) as scratch, tarfile.open(archive) as bundle:
        verify_manifest(ET.fromstring(bundle.extractfile("richdocuments/appinfo/info.xml").read()))
        members = [member for member in bundle.getmembers() if Path(member.name).parts[:1] == ("richdocuments",)]
        bundle.extractall(scratch, members, filter="data")
        (Path(scratch) / "richdocuments").rename(prepared)
verify_manifest(ET.parse(prepared / "appinfo" / "info.xml").getroot())
print("Prepared verified Nextcloud Office " + lock["version"])
