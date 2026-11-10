"""Run inside the isolated service container; real kernel and HTTP, synthetic files."""
import base64
import hashlib
import http.client
import json
from pathlib import Path
import sys
import time

MARKER = "Hyper Office batch verified"
source_root, output_root = map(Path, sys.argv[1:])


def call(route, value=None):
    connection = http.client.HTTPConnection("127.0.0.1", 3123, timeout=75)
    connection.request("POST" if value else "GET", route, json.dumps(value) if value else None,
                       {"Content-Type": "application/json"})
    response = connection.getresponse()
    result = json.loads(response.read())
    status = response.status
    connection.close()
    return status, result


def clean():
    assert not list(Path("/tmp").glob("hyper-office-*")), "Request profile leaked"
    # Container init reaps any killed child before the next job.
    for _ in range(30):
        alive = []
        for process in Path("/proc").glob("[0-9]*/comm"):
            try:
                if process.read_text().strip() == "soffice.bin":
                    alive.append(process)
            except FileNotFoundError:
                pass
        if not alive:
            return
        time.sleep(0.1)
    raise AssertionError("soffice process leaked")


def transform(payload, operations, expected_status=200):
    result_status, result = call("/transform", {**payload, "operations": operations})
    assert result_status == expected_status, (result_status, result)
    clean()
    if expected_status == 200:
        assert result["summary"]["reopenedVerified"] is True
        content = base64.b64decode(result["contentBase64"], validate=True)
        assert hashlib.sha256(content).hexdigest() == result["outputSha256"]
        (output_root / ("edited." + payload["format"])).write_bytes(content)
    return result


for _ in range(30):
    try:
        assert call("/health")[0] == 200
        break
    except OSError:
        time.sleep(0.2)
else:
    raise AssertionError("Service not ready")

results = []
for kind in ("docx", "xlsx", "pptx"):
    source = (source_root / ("roundtrip-seed." + kind)).read_bytes()
    payload = {"format": kind, "contentBase64": base64.b64encode(source).decode()}
    status, inspected = call("/inspect", payload)
    assert status == 200, (kind, status, inspected)
    clean()
    digest = hashlib.sha256(source).hexdigest()
    assert inspected["sourceSha256"] == digest
    payload["sourceSha256"] = digest
    if kind == "docx":
        target = next(item for item in inspected["inspection"]["paragraphs"] if item["text"] == "Editable text")
        assert target["editable"] is True
        replace = {"kind": "writer.replace", "target": target["id"], "expectedText": target["text"], "text": MARKER}
        transform(payload, [{**replace, "expectedText": "wrong expected private source"}], 409)
        transform(payload, [replace])
        # Separate append path, with the same preservation fixture applied to its output.
        append = transform(payload, [{"kind": "writer.append", "target": "document:end", "text": MARKER}])
        assert append["summary"]["operations"][0]["before"] is None
    elif kind == "xlsx":
        sheets = inspected["inspection"]["sheets"]
        report = next(sheet for sheet in sheets if sheet["name"] == "Report")
        target = next(cell for cell in report["cells"] if cell["address"] == "B5")
        assert target["editable"] is True
        operation = {"kind": "calc.set", "sheet": report["id"], "cell": "B5",
                     "expected": {"type": target["type"], "value": target["value"]},
                     "value": {"type": "string", "value": MARKER}}
        unsafe = {**operation, "value": {"type": "formula", "value": '=WEBSERVICE("https://secret.invalid")'}}
        transform(payload, [unsafe], 422)
        result = transform(payload, [operation, {"kind": "calc.set", "sheet": report["id"], "cell": "B6",
                                    "expected": {"type": "empty", "value": None},
                                    "value": {"type": "formula", "value": "=SUM(Inputs!D2:D3)"}}])
        assert result["summary"]["recalculated"] is True
        assert result["summary"]["formulaErrors"] == []
        status, reloaded = call("/inspect", {"format": kind, "contentBase64": result["contentBase64"]})
        assert status == 200
        saved_report = next(sheet for sheet in reloaded["inspection"]["sheets"] if sheet["name"] == "Report")
        assert next(cell for cell in saved_report["cells"] if cell["address"] == "B6")["display"] == "40"
        clean()
    else:
        assert all(isinstance(shape["text"], str) for slide in inspected["inspection"]["slides"] for shape in slide["shapes"])
        target = next(shape for slide in inspected["inspection"]["slides"] for shape in slide["shapes"] if shape["text"] == "Editable text")
        assert target["editable"] is True
        transform(payload, [{"kind": "impress.replace", "target": target["id"], "expectedText": target["text"], "text": MARKER}])
    results.append({"format": kind, "realKernel": True, "http": True, "readback": True, "cleanup": True})
print(json.dumps({"status": "passed", "results": results}))
