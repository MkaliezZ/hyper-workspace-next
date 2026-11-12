"""Pure protocol/package validation; never interprets model code."""
import base64
import binascii
import hashlib
import io
import math
import re
import stat
import zipfile
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET

PROTOCOL = "office-batch/v1"
ENGINE = "collabora-26.04.6.1/pyuno-26.04.6-1"
MAX_FILE = 8 * 1024 * 1024
MAX_JSON = 12 * 1024 * 1024
MAX_TEXT = 4000
MAX_PREVIEW = 200000
MAX_CELLS = 2000
FORMATS = {"docx": "word/document.xml", "xlsx": "xl/workbook.xml", "pptx": "ppt/presentation.xml"}
URL = re.compile(r"(?:[a-z][a-z0-9+.-]*://|\b(?:mailto|file|data|javascript|vnd\.[\w.]+):|\bwww\.|\\\\)", re.I)


class Rejected(Exception):
    def __init__(self, code, status=422):
        self.code, self.status = code, status
        super().__init__(code)


def require(condition, code="invalid_operation", status=422):
    if not condition:
        raise Rejected(code, status)


def keys(value, expected):
    require(isinstance(value, dict) and set(value) == set(expected), "invalid_schema")


def text(value):
    require(isinstance(value, str) and len(value) <= MAX_TEXT, "text_limit", 413)
    require(not any(ord(char) < 32 and char not in "\t" for char in value), "invalid_text")
    require(not URL.search(value), "new_link_forbidden")
    return value


def address(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Z]{1,2}[1-9][0-9]{0,3}", value), "invalid_cell")
    letters, digits = re.fullmatch(r"([A-Z]+)([0-9]+)", value).groups()
    column = 0
    for char in letters:
        column = column * 26 + ord(char) - 64
    require(column <= 64 and int(digits) <= 1000, "target_limit", 413)
    return column - 1, int(digits) - 1


def scalar(value, *, incoming=False):
    keys(value, ("type", "value"))
    kind, item = value["type"], value["value"]
    require(kind in ("empty", "string", "number", "formula"), "invalid_cell_type")
    if kind == "empty":
        require(item is None)
    elif kind == "number":
        require(type(item) in (int, float) and math.isfinite(item) and abs(item) <= 1e100, "invalid_number")
    else:
        require(isinstance(item, str) and len(item) <= MAX_TEXT, "text_limit", 413)
        if incoming:
            text(item)
            if kind == "string":
                require(item != "", "use_empty_cell_type")
            if kind == "formula":
                formula(item)  # Syntax first, sheet existence checked in the engine.
    return value


def validate_operations(operations, kind):
    require(isinstance(operations, list) and 1 <= len(operations) <= 32, "operation_limit", 413)
    seen = set()
    for op in operations:
        require(isinstance(op, dict) and isinstance(op.get("kind"), str), "invalid_schema")
        name = op["kind"]
        if name == "writer.append" and kind == "docx":
            keys(op, ("kind", "target", "text"))
            require(op["target"] == "document:end")
        elif name == "writer.replace" and kind == "docx":
            keys(op, ("kind", "target", "expectedText", "text"))
            require(isinstance(op["target"], str) and re.fullmatch(r"paragraph:[0-9]{1,4}", op["target"]))
        elif name == "impress.replace" and kind == "pptx":
            keys(op, ("kind", "target", "expectedText", "text"))
            require(isinstance(op["target"], str) and re.fullmatch(r"slide:[0-9]{1,3}/shape:[0-9]{1,4}", op["target"]))
        elif name == "calc.set" and kind == "xlsx":
            keys(op, ("kind", "sheet", "cell", "expected", "value"))
            require(isinstance(op["sheet"], str) and re.fullmatch(r"sheet:[0-9]{1,2}", op["sheet"]))
            address(op["cell"])
            scalar(op["expected"])
            scalar(op["value"], incoming=True)
        else:
            raise Rejected("unsupported_operation")
        if "text" in op:
            text(op["text"])
        if "expectedText" in op:
            require(isinstance(op["expectedText"], str) and len(op["expectedText"]) <= MAX_TEXT, "text_limit", 413)
        target = (op.get("sheet"), op.get("cell")) if name == "calc.set" else op["target"]
        require(target not in seen, "duplicate_target")
        seen.add(target)


# A small arithmetic parser, not a blacklist over unrestricted spreadsheet formulas.
# Both Excel-style input and the engine's own internal-reference spelling are
# lexed as references; dots/quotes are never rewritten across an arbitrary formula.
SHEET_TOKEN = r"\$?(?:'(?:[^'\r\n]|''){1,64}'|[A-Za-z_][A-Za-z0-9_]{0,63})"
CELL_TOKEN = r"\$?[A-Z]{1,2}\$?[1-9][0-9]{0,3}"
REF_TOKEN = rf"(?:(?:{SHEET_TOKEN})[!.])?{CELL_TOKEN}"
REFERENCE = re.compile(rf"(?:(?P<sheet>{SHEET_TOKEN})[!.])?(?P<cell>{CELL_TOKEN})")
TOKEN = re.compile(rf"\s*(?:(?P<number>(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[Ee][+-]?[0-9]+)?)|(?P<ref>{REF_TOKEN})|(?P<word>[A-Z]+)|(?P<op>[+*/^(),;:\-]))")


def formula(value, sheets=None):
    require(isinstance(value, str) and value.startswith("=") and len(value) <= 1024, "invalid_formula")
    tokens, offset = [], 1
    while offset < len(value):
        match = TOKEN.match(value, offset)
        require(match is not None, "invalid_formula")
        tokens.append((match.lastgroup, match.group(match.lastgroup)))
        offset = match.end()
    require(0 < len(tokens) <= 128, "formula_limit", 413)
    position, depth = 0, 0

    def reference(token):
        parsed = REFERENCE.fullmatch(token)
        require(parsed is not None, "invalid_formula")
        sheet, cell = parsed.group("sheet"), parsed.group("cell")
        if sheet is not None:
            sheet = sheet.removeprefix("$")
            if sheet.startswith("'"):
                sheet = sheet[1:-1].replace("''", "'")
            require(0 < len(sheet) <= 64 and not any(c in sheet for c in "[]:/\\?*")
                    and not any(ord(c) < 32 for c in sheet) and not URL.search(sheet), "invalid_formula")
            require(sheets is None or sheet in sheets, "unknown_sheet")
            prefix = "$'" + sheet.replace("'", "''") + "'."
        else:
            prefix = ""
        address(cell.replace("$", ""))
        return prefix + cell, sheet, cell

    def expression():
        nonlocal position, depth
        depth += 1
        require(depth <= 16, "formula_limit", 413)
        result = atom()
        while position < len(tokens) and tokens[position][1] in ("+", "-", "*", "/", "^"):
            operator = tokens[position][1]
            position += 1
            result += operator + atom()
        depth -= 1
        return result

    def atom():
        nonlocal position
        require(position < len(tokens), "invalid_formula")
        kind, token = tokens[position]
        position += 1
        if token in ("+", "-"):
            # Count recursive unary operators toward the depth limit.
            require(position < len(tokens) and tokens[position][1] not in ("+", "-"), "invalid_formula")
            return token + atom()
        if kind == "number":
            require(math.isfinite(float(token)) and abs(float(token)) <= 1e100, "invalid_formula")
            return token
        if kind == "ref":
            result, first_sheet, first_cell = reference(token)
            if position < len(tokens) and tokens[position][1] == ":":
                position += 1
                require(position < len(tokens) and tokens[position][0] == "ref", "invalid_formula")
                end = tokens[position][1]
                position += 1
                end_result, last_sheet, last_cell = reference(end)
                x1, y1 = address(first_cell.replace("$", ""))
                x2, y2 = address(last_cell.replace("$", ""))
                require((abs(x2-x1)+1)*(abs(y2-y1)+1) <= MAX_CELLS, "formula_limit", 413)
                require(last_sheet is None or first_sheet == last_sheet, "invalid_formula")
                result += ":" + end_result
            return result
        if kind == "word":
            require(token in ("SUM", "MIN", "MAX", "AVERAGE", "COUNT"), "unsupported_formula")
            require(position < len(tokens) and tokens[position][1] == "(", "invalid_formula")
            position += 1
            args = [expression()]
            while position < len(tokens) and tokens[position][1] in (",", ";"):
                position += 1
                args.append(expression())
            require(position < len(tokens) and tokens[position][1] == ")", "invalid_formula")
            position += 1
            return token + "(" + ";".join(args) + ")"
        if token == "(":
            result = expression()
            require(position < len(tokens) and tokens[position][1] == ")", "invalid_formula")
            position += 1
            return "(" + result + ")"
        raise Rejected("invalid_formula")

    result = expression()
    require(position == len(tokens), "invalid_formula")
    return "=" + result


def package(data, kind):
    require(0 < len(data) <= MAX_FILE, "file_limit", 413)
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            require(0 < len(infos) <= 2048, "package_limit", 413)
            seen, expanded = set(), 0
            for entry in infos:
                name = entry.filename
                path = PurePosixPath(name)
                require(name not in seen and not path.is_absolute() and ".." not in path.parts and "\\" not in name, "invalid_package")
                seen.add(name)
                require(not entry.flag_bits & 1 and not stat.S_ISLNK(entry.external_attr >> 16), "unsupported_package")
                require(entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "unsupported_package")
                expanded += entry.file_size
                require(entry.file_size <= 16 * 1024 * 1024 and expanded <= 64 * 1024 * 1024 and entry.file_size <= max(1, entry.compress_size) * 200, "package_limit", 413)
                lower = name.lower()
                require(not any(part in lower for part in ("vbaproject", "/activex/", "/embeddings/")), "unsupported_active_object")
                # Bounded reads verify CRC and prevent crafted metadata from bypassing limits.
                content = archive.read(entry)
                require(len(content) == entry.file_size, "invalid_package")
                if lower.endswith((".xml", ".rels")):
                    # OOXML may legally use other encodings; v1 explicitly rejects
                    # them so UTF-16/32 cannot hide DTD, entity or macro markers.
                    try:
                        xml = content.decode("utf-8-sig")
                    except UnicodeError:
                        raise Rejected("unsupported_xml_encoding") from None
                    require("\x00" not in xml, "unsupported_xml_encoding")
                    encoding = re.match(r"\s*<\?xml\s[^>]*\bencoding\s*=\s*['\"]([^'\"]+)['\"]", xml, re.I)
                    require(encoding is None or encoding.group(1).lower() in ("utf-8", "utf8"), "unsupported_xml_encoding")
                    require("<!DOCTYPE" not in xml.upper() and "<!ENTITY" not in xml.upper(), "invalid_xml")
                    ET.fromstring(xml)
            require(FORMATS[kind] in seen and "[Content_Types].xml" in seen, "format_mismatch")
            types = archive.read("[Content_Types].xml").lower()
            require(b"macroenabled" not in types and b"vbaproject" not in types, "unsupported_package")
    except Rejected:
        raise
    except (zipfile.BadZipFile, KeyError, ValueError, ET.ParseError, RuntimeError, NotImplementedError):
        raise Rejected("invalid_package") from None


def request(value, transform=False):
    keys(value, ("format", "contentBase64", "sourceSha256", "operations") if transform else ("format", "contentBase64"))
    kind = value["format"]
    require(isinstance(kind, str) and kind in FORMATS, "unsupported_format")
    encoded = value["contentBase64"]
    require(isinstance(encoded, str) and len(encoded) <= ((MAX_FILE + 2) // 3) * 4, "file_limit", 413)
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise Rejected("invalid_base64") from None
    require(base64.b64encode(data).decode() == encoded, "invalid_base64")
    package(data, kind)
    if kind == "xlsx":
        from pivots import features
        try:
            features(data)
        except (ValueError, TypeError, KeyError, IndexError, AttributeError):
            raise Rejected("unsupported_pivot_source") from None
    digest = hashlib.sha256(data).hexdigest()
    if transform:
        require(value["sourceSha256"] == digest, "source_mismatch", 409)
        validate_operations(value["operations"], kind)
    return data, digest
