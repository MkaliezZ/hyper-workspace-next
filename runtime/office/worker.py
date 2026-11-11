"""One fixed-operation UNO job. Invoked only by the private service."""
import json
import math
import os
from pathlib import Path
import resource
import subprocess
import sys
import time

from sandbox import deny_ip_network
import pivots
from validation import MAX_CELLS, MAX_FILE, MAX_PREVIEW, MAX_TEXT, Rejected, address, formula, require

PROGRAM = Path("/opt/collaboraoffice/program")
FILTERS = {"docx": "Office Open XML Text", "xlsx": "Calc MS Excel 2007 XML", "pptx": "Impress MS PowerPoint 2007 XML"}


def prop(name, value):
    result = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
    result.Name, result.Value = name, value
    return result


def load(desktop, path, readonly=False):
    document = desktop.loadComponentFromURL(path.as_uri(), "_blank", 0, (
        prop("Hidden", True), prop("ReadOnly", readonly),
        prop("MacroExecutionMode", uno.Any("short", 0)), prop("UpdateDocMode", uno.Any("short", 0)),
    ))
    require(document is not None, "document_load_failed")
    return document


def plain_text(target):
    try:
        enumeration = target.createEnumeration()
        while enumeration.hasMoreElements():
            part = enumeration.nextElement()
            if part.supportsService("com.sun.star.text.Paragraph"):
                if not plain_text(part):
                    return False
            elif getattr(part, "TextPortionType", "") != "Text" or getattr(part, "HyperLinkURL", ""):
                return False
        return True
    except Exception:
        return False


def paragraphs(document):
    result = []
    enumeration = document.getText().createEnumeration()
    while enumeration.hasMoreElements():
        target = enumeration.nextElement()
        if target.supportsService("com.sun.star.text.Paragraph"):
            result.append(target)
            require(len(result) <= 1000, "target_limit", 413)
    return result


def cell_value(cell):
    kind = cell.getType().value
    if kind == "EMPTY":
        return {"type": "empty", "value": None}
    if kind == "TEXT":
        return {"type": "string", "value": cell.String}
    if kind == "VALUE":
        return {"type": "number", "value": cell.Value}
    return {"type": "formula", "value": cell.Formula}


def cell_editable(sheet, cell):
    # Expand-to-merged also catches non-anchor cells within a merged range.
    cursor = sheet.createCursorByRange(cell)
    cursor.collapseToMergedArea()
    merged = cursor.getRangeAddress()
    return not sheet.isProtected() and merged.StartColumn == merged.EndColumn and merged.StartRow == merged.EndRow


def cell_name(column, row):
    name = ""
    column += 1
    while column:
        column, remainder = divmod(column - 1, 26)
        name = chr(65 + remainder) + name
    return name + str(row + 1)


def inspect(document, kind, pivot_features=()):
    preview = 0

    def bounded(value):
        nonlocal preview
        require(len(value) <= MAX_TEXT, "text_limit", 413)
        preview += len(value)
        require(preview <= MAX_PREVIEW, "preview_limit", 413)
        return value

    if kind == "docx":
        require(document.supportsService("com.sun.star.text.TextDocument"), "format_mismatch")
        return {"paragraphs": [{"id": f"paragraph:{index}", "text": bounded(target.String), "editable": plain_text(target)}
                               for index, target in enumerate(paragraphs(document))], "appendTarget": "document:end"}
    if kind == "xlsx":
        require(document.supportsService("com.sun.star.sheet.SpreadsheetDocument"), "format_mismatch")
        sheets = document.getSheets()
        require(sheets.getCount() <= 16, "target_limit", 413)
        result, count = [], 0
        for index in range(sheets.getCount()):
            sheet = sheets.getByIndex(index)
            cursor = sheet.createCursor()
            cursor.gotoEndOfUsedArea(False)
            extent = cursor.getRangeAddress()
            columns, rows = extent.EndColumn + 1, extent.EndRow + 1
            count += columns * rows
            require(rows <= 1000 and columns <= 64 and count <= MAX_CELLS, "target_limit", 413)
            cells = []
            for row in range(rows):
                for column in range(columns):
                    cell = sheet.getCellByPosition(column, row)
                    value = cell_value(cell)
                    if isinstance(value["value"], str):
                        bounded(value["value"])
                    cells.append({"address": cell_name(column, row), **value, "display": bounded(cell.String),
                                  "error": cell.getError(), "editable": cell_editable(sheet, cell)
                                  and all(pivots.editable(item, index, column, row) for item in pivot_features)})
            result.append({"id": f"sheet:{index}", "name": sheet.Name, "rows": rows, "columns": columns, "cells": cells})
        return {"sheets": result}
    require(document.supportsService("com.sun.star.presentation.PresentationDocument"), "format_mismatch")
    slides = document.getDrawPages()
    require(slides.getCount() <= 100, "target_limit", 413)
    result, count = [], 0
    for index in range(slides.getCount()):
        slide = slides.getByIndex(index)
        shapes = []
        count += slide.getCount()
        require(count <= 1000, "target_limit", 413)
        for shape_index in range(slide.getCount()):
            shape = slide.getByIndex(shape_index)
            string = getattr(shape, "String", None)
            editable = string is not None and shape.supportsService("com.sun.star.drawing.Text") and plain_text(shape)
            shapes.append({"id": f"slide:{index}/shape:{shape_index}", "text": bounded(string) if string is not None else "",
                           "editable": editable})
        result.append({"id": f"slide:{index}", "shapes": shapes})
    return {"slides": result}


def formula_errors(inspection):
    return [{"sheet": sheet["id"], "cell": cell["address"], "error": cell["error"]}
            for sheet in inspection["sheets"] for cell in sheet["cells"] if cell["error"]]


def formula_snapshot(inspection):
    return [(sheet["id"], cell["address"], cell["value"], cell["display"], cell["error"])
            for sheet in inspection["sheets"] for cell in sheet["cells"] if cell["type"] == "formula"]


def pivot_state(document, feature, refresh=False):
    sheets = document.getSheets()
    sheet = sheets.getByIndex(feature["sourceSheet"])
    output_sheet = sheets.getByIndex(feature["outputSheet"])
    tables = output_sheet.getDataPilotTables()
    require(tables.hasByName(feature["name"]), "pivot_readback_mismatch")
    table = tables.getByName(feature["name"])
    source = table.getSourceRange()
    require((source.StartColumn, source.StartRow, source.EndColumn, source.EndRow) == feature["sourceBounds"]
            and source.Sheet == feature["sourceSheet"] and not table.getPropertyValue("SourceServiceName"), "unsupported_pivot_source")
    x1, y1, x2, y2 = feature["sourceBounds"]
    records = sheet.getCellRangeByPosition(x1, y1, x2, y2).getDataArray()
    require(list(records[0]) == feature["fieldNames"] and len(set(records[0])) == len(records[0]), "unsupported_pivot_source")
    groups = {}
    for row_index, record in enumerate(records[1:], y1+1):
        for column in range(x1, x2+1):
            cell = sheet.getCellByPosition(column, row_index)
            require(cell.getType().value in ("EMPTY", "TEXT", "VALUE") and cell.getError() == 0, "unsupported_pivot_value")
        key, value = record[feature["rowField"]], record[feature["dataField"]]
        require(isinstance(key, str) and key and type(value) in (int, float) and math.isfinite(value), "unsupported_pivot_value")
        groups.setdefault(key, []).append(value)
    if refresh:
        table.refresh()
    out = table.getOutputRange()
    require((out.StartColumn, out.StartRow, out.EndColumn, out.EndRow) == feature["outputBounds"]
            and out.Sheet == feature["outputSheet"], "unsupported_pivot_layout")
    values = output_sheet.getCellRangeByPosition(out.StartColumn, out.StartRow, out.EndColumn, out.EndRow).getDataArray()
    require(len(values) == len(groups)+2 and values[0] == (records[0][feature["rowField"]], feature["dataName"])
            and values[-1][0] == "Total Result", "pivot_readback_mismatch")
    def equal(left, right):
        return type(left) in (int, float) and math.isclose(left, right, rel_tol=1e-12, abs_tol=1e-12)
    observed = dict(values[1:-1])
    require(set(observed) == set(groups) and all(equal(observed[key], math.fsum(value)) for key, value in groups.items())
            and equal(values[-1][1], math.fsum(value for row in groups.values() for value in row)), "pivot_readback_mismatch")
    return records[1:], values


def apply(document, kind, inspection, operations, pivot_features=()):
    checks = []
    if kind == "docx":
        targets = dict(zip((p["id"] for p in inspection["paragraphs"]), paragraphs(document)))
        records = {p["id"]: p for p in inspection["paragraphs"]}
    elif kind == "pptx":
        targets, records = {}, {}
        for slide_index, slide in enumerate(inspection["slides"]):
            for shape_index, shape in enumerate(slide["shapes"]):
                targets[shape["id"]] = document.getDrawPages().getByIndex(slide_index).getByIndex(shape_index)
                records[shape["id"]] = shape
    else:
        sheets = {sheet["id"]: document.getSheets().getByIndex(index) for index, sheet in enumerate(inspection["sheets"])}
        sheet_names = [sheet["name"] for sheet in inspection["sheets"]]

    # Preflight every target/expected value before any modification.
    for op in operations:
        if op["kind"] == "writer.append":
            checks.append((op, None, None))
        elif op["kind"] == "calc.set":
            require(op["sheet"] in sheets, "unknown_target")
            sheet = sheets[op["sheet"]]
            column, row = address(op["cell"])
            require(all(pivots.editable(item, int(op["sheet"].split(":")[1]), column, row)
                        for item in pivot_features), "unsupported_pivot_target")
            cell = sheet.getCellByPosition(column, row)
            require(cell_editable(sheet, cell), "unsupported_target")
            before = cell_value(cell)
            require(before == op["expected"], "expected_mismatch", 409)
            if op["value"]["type"] == "formula":
                formula(op["value"]["value"], sheet_names)
            checks.append((op, cell, before))
        else:
            require(op["target"] in targets, "unknown_target")
            record = records[op["target"]]
            require(record["editable"], "unsupported_target")
            require(record["text"] == op["expectedText"], "expected_mismatch", 409)
            checks.append((op, targets[op["target"]], record["text"]))

    summary = []
    for op, target, before in checks:
        name = op["kind"]
        if name == "writer.append":
            body = document.getText()
            body.insertControlCharacter(body.getEnd(), uno.getConstantByName("com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK"), False)
            body.insertString(body.getEnd(), op["text"], False)
            result_target = f"paragraph:{len(paragraphs(document))-1}"
            after = op["text"]
        elif name == "calc.set":
            value = op["value"]
            if value["type"] == "number":
                target.Value = value["value"]
            elif value["type"] == "formula":
                target.Formula = formula(value["value"], sheet_names)
            elif value["type"] == "empty":
                target.clearContents(1 | 2 | 4 | 16)  # Values/text/formulas; preserve cell formatting and annotations.
            else:
                target.String = value["value"]
            after = cell_value(target)
            result_target = op["sheet"] + "/" + op["cell"]
        else:
            target.String = op["text"]
            after, result_target = op["text"], op["target"]
        summary.append({"kind": name, "target": result_target, "before": before, "after": after})
    if kind == "xlsx":
        document.calculateAll()
        for item in pivot_features:
            pivot_state(document, item, refresh=True)
        document.calculateAll()
        for op, cell, _ in checks:
            if op["value"]["type"] == "formula":
                require(cell.getError() == 0, "calculation_failed")
    return summary


def verify(inspection, summary, kind, document):
    if kind == "docx":
        values = {p["id"]: p["text"] for p in inspection["paragraphs"]}
    elif kind == "pptx":
        values = {shape["id"]: shape["text"] for slide in inspection["slides"] for shape in slide["shapes"]}
    else:
        values = {}
        for item in summary:
            sheet_id, cell = item["target"].split("/")
            sheet = document.getSheets().getByIndex(int(sheet_id.split(":")[1]))
            values[item["target"]] = cell_value(sheet.getCellRangeByName(cell))
    require(all(item["target"] in values and values[item["target"]] == item["after"] for item in summary), "readback_mismatch")


def execute(directory):
    job = json.loads((directory / "job.json").read_text())
    kind = job["format"]
    pivot_features = pivots.features((directory / "source.xlsx").read_bytes()) if kind == "xlsx" else []
    profile = directory / "profile"
    (profile / "user").mkdir(parents=True)
    (profile / "user/registrymodifications.xcu").write_text('''<?xml version="1.0"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting">
<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
</item></oor:items>''')
    pipe = "hyper_" + directory.name.replace("-", "_")
    connection = "pipe,name=" + pipe + ";urp;StarOffice.ComponentContext"
    engine = subprocess.Popen([str(PROGRAM / "soffice.bin"), "-env:UserInstallation=" + profile.as_uri(),
                               "--headless", "--nologo", "--nodefault", "--nofirststartwizard", "--norestore",
                               "--accept=" + connection], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    desktop = None
    try:
        context = uno.getComponentContext()
        resolver = context.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", context)
        deadline = time.monotonic() + 20
        while True:
            try:
                remote = resolver.resolve("uno:" + connection)
                break
            except Exception:
                require(engine.poll() is None and time.monotonic() < deadline, "engine_start_failed", 500)
                time.sleep(0.1)
        provider = remote.ServiceManager.createInstanceWithContext("com.sun.star.configuration.ConfigurationProvider", remote)
        security = provider.createInstanceWithArguments("com.sun.star.configuration.ConfigurationAccess", (
            prop("nodepath", "/org.openoffice.Office.Common/Security/Scripting"),))
        require(security.getPropertyValue("DisableMacrosExecution") is True, "unsafe_engine_config", 500)
        desktop = remote.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", remote)
        document = load(desktop, directory / ("source." + kind))
        try:
            for item in pivot_features:
                pivot_state(document, item, refresh=True)
            inspection = inspect(document, kind, pivot_features)
            if not job["transform"]:
                return {"inspection": inspection}
            summary = apply(document, kind, inspection, job["operations"], pivot_features)
            after = inspect(document, kind, pivot_features)  # Check output target bounds before save.
            pivot_before_save = [pivot_state(document, item) for item in pivot_features]
            errors = formula_errors(after) if kind == "xlsx" else []
            document.storeAsURL((directory / ("output." + kind)).as_uri(), (
                prop("FilterName", FILTERS[kind]), prop("Overwrite", False)))
        finally:
            document.close(True)
        require((directory / ("output." + kind)).stat().st_size <= MAX_FILE, "output_limit", 413)
        if pivot_features:
            content = (directory / "output.xlsx").read_bytes()
            saved_features = pivots.features(content)
            require(pivots.signature(saved_features) == pivots.signature(pivot_features), "pivot_readback_mismatch")
            for feature, (records, _) in zip(saved_features, pivot_before_save):
                require(pivots.cache_records(content, feature) == records, "pivot_cache_mismatch")
        reopened = load(desktop, directory / ("output." + kind), True)
        try:
            saved = inspect(reopened, kind, pivot_features)
            verify(saved, summary, kind, reopened)
            if kind == "xlsx":
                require(formula_errors(saved) == errors, "readback_mismatch")
                require(formula_snapshot(saved) == formula_snapshot(after), "readback_mismatch")
                require([pivot_state(reopened, item) for item in pivot_features] == pivot_before_save, "pivot_readback_mismatch")
        finally:
            reopened.close(True)
        return {"summary": {"operations": summary, "recalculated": kind == "xlsx", "formulaErrors": errors,
                            "reopenedVerified": True}}
    finally:
        if desktop is not None:
            desktop.terminate()
        try:
            engine.wait(timeout=3)
        except subprocess.TimeoutExpired:
            engine.kill()
            engine.wait()


if __name__ == "__main__":
    directory = Path(sys.argv[1]).resolve()
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
        os.umask(0o077)
        deny_ip_network()
        import uno
        result = execute(directory)
    except Rejected as error:
        result = {"error": {"code": error.code, "status": error.status}}
    except Exception:
        result = {"error": {"code": "engine_failed", "status": 500}}
    (directory / "result.json").write_text(json.dumps(result, ensure_ascii=False, allow_nan=False))
