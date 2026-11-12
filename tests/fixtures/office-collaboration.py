"""Synthetic DOCX and read-only OOXML checks for real multi-user Office tests."""
import io
import json
import re
import sys
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


def create(revision_target="Revision target"):
    from docx import Document
    document = Document()
    document.add_heading("Synthetic shared review", level=1)
    for text in ("Alice edit target", "Bob edit target", revision_target):
        document.add_paragraph(text)
    table = document.add_table(rows=2, cols=2)
    for row, values in zip(table.rows, [("Item", "Quantity"), ("Pens", "3")]):
        for cell, value in zip(row.cells, values):
            cell.text = value
    output = io.BytesIO()
    document.save(output)
    return output.getvalue()


def texts(node):
    return "".join(element.text or "" for element in node.findall(".//w:t", NS))


def verify(path, expected):
    with ZipFile(path) as package:
        document = ET.fromstring(package.read("word/document.xml"))
        comments = ET.fromstring(package.read("word/comments.xml")) if "word/comments.xml" in package.namelist() else ET.Element("comments")
        persisted_text = "".join("".join(ET.fromstring(package.read(name)).itertext())
                                 for name in package.namelist() if name.endswith(".xml"))
    text = texts(document)
    assert "Synthetic shared review" in text, "The original heading changed"
    table = document.find(".//w:tbl", NS)
    assert table is not None, "The original table is absent"
    assert [[texts(cell) for cell in row.findall("w:tc", NS)]
            for row in table.findall("w:tr", NS)] == [["Item", "Quantity"], ["Pens", "3"]], "The original table changed"
    for marker in expected.get("text", []):
        assert marker in text, "A required saved edit is absent"
    for marker in expected.get("absent", []):
        assert marker not in persisted_text, "A forbidden edit reached the source file"
    for author, marker in expected.get("comments", {}).items():
        assert any(item.get("{" + NS["w"] + "}author") == author and marker in texts(item)
                   for item in comments.findall("w:comment", NS)), "A persisted author comment is absent"
    if expected.get("tracked"):
        assert any(item.get("{" + NS["w"] + "}author") == expected["tracked"]["author"]
                   and expected["tracked"]["text"] in texts(item)
                   for item in document.findall(".//w:ins", NS)), "The authored tracked insertion is absent"
        if expected["tracked"].get("deletedText"):
            assert any(item.get("{" + NS["w"] + "}author") == expected["tracked"]["author"]
                       and expected["tracked"]["deletedText"] in "".join(node.text or "" for node in item.findall(".//w:delText", NS))
                       for item in document.findall(".//w:del", NS)), "The authored tracked deletion is absent"
    if expected.get("accepted"):
        assert not document.findall(".//w:ins", NS) and not document.findall(".//w:del", NS), "Tracked revisions remain after acceptance"
    return {"edits": len(expected.get("text", [])),
            "comments": len(expected.get("comments", {})),
            "tracked": bool(expected.get("tracked")),
            "accepted": bool(expected.get("accepted")),
            "forbiddenAbsent": len(expected.get("absent", []))}


def diagnose(path, expected):
    """Describe the actual saved package using only fixed keys and booleans/counts."""
    with ZipFile(path) as package:
        document = ET.fromstring(package.read("word/document.xml"))
        comments = ET.fromstring(package.read("word/comments.xml")) if "word/comments.xml" in package.namelist() else ET.Element("comments")
        persisted_text = "".join("".join(ET.fromstring(package.read(name)).itertext())
                                 for name in package.namelist() if name.endswith(".xml"))
    text = texts(document)
    tracked = expected.get("tracked", {})
    author = tracked.get("author")
    marker = tracked.get("text")
    deleted = tracked.get("deletedText")
    insertions = document.findall(".//w:ins", NS)
    deletions = document.findall(".//w:del", NS)
    authored_insertions = [item for item in insertions if item.get("{" + NS["w"] + "}author") == author]
    authored_deletions = [item for item in deletions if item.get("{" + NS["w"] + "}author") == author]
    deleted_text = lambda item: "".join(node.text or "" for node in item.findall(".//w:delText", NS))
    table = document.find(".//w:tbl", NS)
    return {
        "headingPreserved": "Synthetic shared review" in text,
        "tablePreserved": table is not None and [[texts(cell) for cell in row.findall("w:tc", NS)]
                                                for row in table.findall("w:tr", NS)] == [["Item", "Quantity"], ["Pens", "3"]],
        "requiredEditsPresent": [value in text for value in expected.get("text", [])],
        "requiredForbiddenAbsent": [value not in persisted_text for value in expected.get("absent", [])],
        "requiredCommentsPresent": [any(item.get("{" + NS["w"] + "}author") == expected_author and value in texts(item)
                                         for item in comments.findall("w:comment", NS))
                                    for expected_author, value in expected.get("comments", {}).items()],
        "insertions": len(insertions),
        "deletions": len(deletions),
        "authoredInsertions": len(authored_insertions),
        "authoredDeletions": len(authored_deletions),
        "insertionTextMatches": bool(marker) and any(marker in texts(item) for item in insertions),
        "authoredInsertionMatches": bool(marker) and any(marker in texts(item) for item in authored_insertions),
        "authoredInsertionCombinedMatches": bool(marker) and marker in "".join(texts(item) for item in authored_insertions),
        "deletionTextMatches": bool(deleted) and any(deleted in deleted_text(item) for item in deletions),
        "authoredDeletionMatches": bool(deleted) and any(deleted in deleted_text(item) for item in authored_deletions),
        "authoredDeletionCombinedMatches": bool(deleted) and deleted in "".join(deleted_text(item) for item in authored_deletions),
        "originalTextStillVisible": bool(deleted) and deleted in text,
    }


def evidence(path, expected, directory):
    """Export only this test's synthetic source; never credentials or arbitrary files."""
    output = Path(directory)
    output.mkdir(parents=True, exist_ok=True)
    artifact = output / "collaboration-saved.docx"
    artifact.unlink(missing_ok=True)
    summary = {"available": False, "exported": False,
               "stage": "tracked" if expected.get("tracked") else "accepted" if expected.get("accepted") else "collaboration"}
    try:
        if Path(path).stat().st_size > 8 * 1024 * 1024:
            raise ValueError("Synthetic evidence size exceeded")
        with ZipFile(path) as package:
            if sum(item.file_size for item in package.infolist()) > 16 * 1024 * 1024:
                raise ValueError("Synthetic evidence expanded size exceeded")
        inspection = diagnose(path, expected)
        summary.update({"available": True, "inspection": inspection})
        raw = Path(path).read_bytes()
        markers = expected.get("text", [])
        uuid4 = r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
        safe = (len(raw) <= 8 * 1024 * 1024 and inspection["headingPreserved"] and inspection["tablePreserved"]
                and len(markers) >= 2 and re.fullmatch("alice-" + uuid4, markers[0])
                and re.fullmatch("bob-" + uuid4, markers[1]) and all(inspection["requiredEditsPresent"][:2]))
        with ZipFile(path) as package:
            for item in package.infolist():
                if item.filename.startswith("/") or ".." in Path(item.filename).parts or "\\" in item.filename or ":" in item.filename or item.filename.endswith(".bin"):
                    safe = False
                if item.filename.endswith((".xml", ".rels")):
                    xml = package.read(item)
                    # OOXML namespace/schema URLs are normal. External document
                    # links and credential-bearing payloads are not this fixture.
                    if any(marker in xml.lower() for marker in (b"access_token", b"authorization", b"bearer ", b"basic ")):
                        safe = False
                    if any(node.get("TargetMode") == "External" for node in ET.fromstring(xml).iter()):
                        safe = False
        if safe:
            artifact.write_bytes(raw)
            summary["exported"] = True
    except Exception:
        pass
    (output / "summary.json").write_text(json.dumps(summary), encoding="utf8")
    return summary


if __name__ == "__main__":
    if sys.argv[1] == "create":
        sys.stdout.buffer.write(create(sys.argv[2] if len(sys.argv) > 2 else "Revision target"))
    elif sys.argv[1] == "verify":
        print(json.dumps(verify(sys.argv[2], json.loads(sys.argv[3]))))
    elif sys.argv[1] == "diagnose":
        print(json.dumps(diagnose(sys.argv[2], json.loads(sys.argv[3]))))
    elif sys.argv[1] == "evidence":
        print(json.dumps(evidence(sys.argv[2], json.loads(sys.argv[3]), sys.argv[4])))
    else:
        raise ValueError("Unknown fixture action")
