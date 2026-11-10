"""Synthetic DOCX and read-only OOXML checks for real multi-user Office tests."""
import io
import json
import sys
from xml.etree import ElementTree as ET
from zipfile import ZipFile

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


def create():
    from docx import Document
    document = Document()
    document.add_heading("Synthetic shared review", level=1)
    for text in ("Alice edit target", "Bob edit target", "Revision target"):
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
    text = texts(document)
    assert "Synthetic shared review" in text, "The original heading changed"
    table = document.find(".//w:tbl", NS)
    assert table is not None, "The original table is absent"
    assert [[texts(cell) for cell in row.findall("w:tc", NS)]
            for row in table.findall("w:tr", NS)] == [["Item", "Quantity"], ["Pens", "3"]], "The original table changed"
    for marker in expected.get("text", []):
        assert marker in text, "A required saved edit is absent"
    for marker in expected.get("absent", []):
        assert marker not in text, "A forbidden edit reached the source file"
    for author, marker in expected.get("comments", {}).items():
        assert any(item.get("{" + NS["w"] + "}author") == author and marker in texts(item)
                   for item in comments.findall("w:comment", NS)), "A persisted author comment is absent"
    if expected.get("tracked"):
        assert any(item.get("{" + NS["w"] + "}author") == expected["tracked"]["author"]
                   and expected["tracked"]["text"] in texts(item)
                   for item in document.findall(".//w:ins", NS)), "The authored tracked insertion is absent"
    if expected.get("accepted"):
        assert not document.findall(".//w:ins", NS) and not document.findall(".//w:del", NS), "Tracked revisions remain after acceptance"
    return {"edits": len(expected.get("text", [])),
            "comments": len(expected.get("comments", {})),
            "tracked": bool(expected.get("tracked")),
            "accepted": bool(expected.get("accepted")),
            "forbiddenAbsent": len(expected.get("absent", []))}


if __name__ == "__main__":
    if sys.argv[1] == "create":
        sys.stdout.buffer.write(create())
    elif sys.argv[1] == "verify":
        print(json.dumps(verify(sys.argv[2], json.loads(sys.argv[3]))))
    else:
        raise ValueError("Unknown fixture action")
