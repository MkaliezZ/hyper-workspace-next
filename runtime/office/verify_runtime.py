import hashlib
import json
from pathlib import Path

lock = json.loads(Path(__file__).with_name("runtime.lock.json").read_text())
for name, expected in lock["engineFiles"].items():
    with (Path("/opt/collaboraoffice/program") / name).open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != expected:
            raise RuntimeError("Core engine integrity mismatch")
print("Locked Collabora core files unchanged")
