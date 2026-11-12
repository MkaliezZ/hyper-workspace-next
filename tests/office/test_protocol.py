"""Boundaries and cleanup tests; stdlib only, no fake claims of engine fidelity."""
import base64
from functools import partial
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "runtime/office"))
from service import Engine, Handler, Server
from pivots import cache_records, features as pivot_features
from validation import Rejected, formula, package, request, validate_operations


def seed(extra=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", "<document/>")
        for name, content in (extra or {}).items():
            archive.writestr(name, content)
    return output.getvalue()


def body(data=None):
    return {"format": "docx", "contentBase64": base64.b64encode(data or seed()).decode()}


def pivot_seed(changes=None, relocated=False):
    namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    pivot_path = 'xl/relocated.xml' if relocated else 'xl/pivotTables/pivotTable1.xml'
    files = {
        '[Content_Types].xml': '<Types/>',
        'xl/workbook.xml': f'<workbook xmlns="{namespace}" xmlns:r="{relationships}"><sheets><sheet name="Inputs" r:id="s1"/><sheet name="Pivot" r:id="s2"/></sheets><pivotCaches><pivotCache cacheId="1" r:id="c1"/></pivotCaches></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="s1" Target="worksheets/sheet1.xml"/><Relationship Id="s2" Target="worksheets/sheet2.xml"/><Relationship Id="c1" Target="pivotCache/cache.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{namespace}"/>',
        'xl/worksheets/sheet2.xml': f'<worksheet xmlns="{namespace}"/>',
        'xl/worksheets/_rels/sheet2.xml.rels': f'<Relationships><Relationship Id="p1" Type="{relationships}/pivotTable" Target="/{pivot_path}"/></Relationships>',
        pivot_path: f'<pivotTableDefinition xmlns="{namespace}" name="LocalPivot" cacheId="1"><location ref="A1:B3"/><rowFields><field x="0"/></rowFields><dataFields><dataField name="Total" fld="1" subtotal="sum"/></dataFields><pivotFields><pivotField axis="axisRow"/><pivotField dataField="1"/></pivotFields></pivotTableDefinition>',
        'xl/pivotCache/cache.xml': f'<pivotCacheDefinition xmlns="{namespace}" xmlns:r="{relationships}" r:id="records"><cacheSource type="worksheet"><worksheetSource sheet="Inputs" ref="A1:B2"/></cacheSource><cacheFields><cacheField name="Item"><sharedItems><s v="Pens"/></sharedItems></cacheField><cacheField name="Quantity"><sharedItems><n v="3"/></sharedItems></cacheField></cacheFields></pivotCacheDefinition>',
        'xl/pivotCache/_rels/cache.xml.rels': '<Relationships><Relationship Id="records" Target="records.xml"/></Relationships>',
        'xl/pivotCache/records.xml': f'<pivotCacheRecords xmlns="{namespace}"><r><x v="0"/><x v="0"/></r></pivotCacheRecords>',
        'xl/styles.xml': f'<styleSheet xmlns="{namespace}"><numFmts><numFmt numFmtId="164" formatCode="General"/></numFmts></styleSheet>',
    }
    for path, old, new in changes or []:
        path = pivot_path if path == 'pivot' else 'xl/pivotCache/cache.xml' if path == 'cache' else path
        files[path] = files[path].replace(old, new)
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return output.getvalue()


class Protocol(unittest.TestCase):
    def rejected(self, code, fn, *args):
        with self.assertRaises(Rejected) as caught:
            fn(*args)
        self.assertEqual(caught.exception.code, code)

    def test_only_exact_input_and_original_hash(self):
        self.assertEqual(request(body())[1], hashlib.sha256(seed()).hexdigest())
        self.rejected("invalid_schema", request, {**body(), "url": "http://secret/token"})
        self.rejected("invalid_base64", request, {**body(), "contentBase64": "===="})
        self.rejected("unsupported_format", request, {**body(), "format": "docm"})
        self.rejected("source_mismatch", request, {**body(), "sourceSha256": "0"*64, "operations": []}, True)

    def test_zip_expansion_paths_active_and_xml(self):
        for extra, error in [({"../secret.xml": "<a/>"}, "invalid_package"),
                             ({"word/vbaProject.bin": "x"}, "unsupported_active_object"),
                             ({"word/embeddings/oleObject1.bin": "x"}, "unsupported_active_object"),
                             ({"word/huge.xml": "x"*100000}, "package_limit"),
                             ({"word/utf16.xml": '<!DOCTYPE a [<!ENTITY x "secret">]><a>&x;</a>'.encode("utf-16")}, "unsupported_xml_encoding"),
                             ({"word/encoding.xml": '<?xml version="1.0" encoding="utf-16"?><a/>'}, "unsupported_xml_encoding"),
                             ({"word/evil.xml": '<!DOCTYPE a [<!ENTITY x "secret">]><a>&x;</a>'}, "invalid_xml")]:
            self.rejected(error, package, seed(extra), "docx")
        self.rejected("format_mismatch", package, seed(), "xlsx")

    def test_fixed_ops_and_no_new_links(self):
        op = {"kind": "writer.replace", "target": "paragraph:0", "expectedText": "old", "text": "new"}
        validate_operations([op], "docx")
        self.rejected("invalid_schema", validate_operations, [{**op, "script": "evil"}], "docx")
        self.rejected("duplicate_target", validate_operations, [op, op], "docx")
        self.rejected("new_link_forbidden", validate_operations, [{**op, "text": "https://secret/token"}], "docx")
        self.rejected("unsupported_operation", validate_operations, [op], "xlsx")
        self.rejected("text_limit", validate_operations, [{**op, "text": "a"*4001}], "docx")
        self.rejected("unsupported_operation", validate_operations, [{"kind": "executeScript"}], "docx")

    def test_formula_allowlist_and_bounds(self):
        self.assertEqual(formula("=SUM(Inputs!D2:D3)", ["Inputs"]), "=SUM($'Inputs'.D2:D3)")
        self.assertEqual(formula("=B2*C2+10"), "=B2*C2+10")
        for expression in ('=WEBSERVICE("https://secret")', '=HYPERLINK("x")', '=DDE("a")',
                           '=INDIRECT(A1)', '=[other.xlsx]Sheet!A1', '=SUM(A1:BL1000)',
                           '=SUM(Unknown!A1)', '=A1+garbage', '=1e999', '=' + '('*20 + '1' + ')'*20):
            with self.subTest(expression=expression), self.assertRaises(Rejected):
                formula(expression, ["Inputs"])

    def test_canonical_internal_formulas_remain_editable_and_bounded(self):
        for expression in ("=AVERAGE(Inputs.D2:D3)", "=AVERAGE($Inputs.D2:D3)", "=AVERAGE($'Inputs'.D2:D3)"):
            self.assertEqual(formula(expression, ["Inputs"]), "=AVERAGE($'Inputs'.D2:D3)")
        self.assertEqual(formula("=SUM($'Sheet Name'.$A$1;'Sheet Name'.B2)", ["Sheet Name"]),
                         "=SUM($'Sheet Name'.$A$1;$'Sheet Name'.B2)")
        self.assertEqual(formula("=SUM('O''Brien'.A1:'O''Brien'!A2)", ["O'Brien"]),
                         "=SUM($'O''Brien'.A1:$'O''Brien'.A2)")
        for expression in ("=SUM(Unknown.A1)", "=SUM(Inputs.A1:Other.B2)", "=SUM(A1:Inputs.B2)",
                           "='file:///tmp/external.xlsx'.A1", "='https://external.invalid'.A1",
                           "='[book.xlsx]Inputs'.A1", "=Inputs.A1:BZ2000", "=Inputs.A1:BL1000",
                           "=SUM(Inputs.A1);WEBSERVICE(A1)", "=DDE(Inputs.A1)", "=Inputs..A1"):
            with self.subTest(expression=expression), self.assertRaises(Rejected):
                formula(expression, ["Inputs", "Other"])

    def test_pivot_is_local_bounded_and_relocated_parts_cannot_bypass(self):
        for relocated in (False, True):
            content = pivot_seed(relocated=relocated)
            item = pivot_features(content)[0]
            self.assertEqual(item["sourceBounds"], (0, 0, 1, 1))
            self.assertEqual(cache_records(content, item), (("Pens", 3.0),))
            rejected = pivot_seed([('pivot', 'cacheId="1"', 'cacheId="1" grandTotalCaption="Private caption"')], relocated)
            self.rejected("unsupported_pivot_caption", request, {"format": "xlsx", "contentBase64": base64.b64encode(rejected).decode()})
        for changes, code in [
            ([('cache', 'type="worksheet"', 'type="external"')], 'unsupported_pivot_source'),
            ([('cache', 'ref="A1:B2"', 'name="ExternalName" ref="A1:B2"')], 'unsupported_pivot_source'),
            ([('cache', 'ref="A1:B2"', 'ref="A1:BZ2000"')], 'target_limit'),
            ([('pivot', 'subtotal="sum"', 'subtotal="average"')], 'unsupported_pivot_aggregation'),
            ([('pivot', 'subtotal="sum"', 'subtotal="sum" numFmtId="2"')], 'unsupported_pivot_aggregation'),
            ([('pivot', '<pivotField axis="axisRow"/>', '<pivotField axis="axisRow" name="Custom label"/>')], 'unsupported_pivot_layout'),
            ([('pivot', 'cacheId="1"', 'cacheId="1" rowHeaderCaption="Custom label"')], 'unsupported_pivot_caption'),
            ([('pivot', 'cacheId="1"', 'cacheId="1" colHeaderCaption="Custom label"')], 'unsupported_pivot_caption'),
            ([('pivot', '<pivotField axis="axisRow"/>', '<pivotField axis="axisRow" subtotalCaption="Custom label"/>')], 'unsupported_pivot_caption'),
            ([('pivot', '<pivotField axis="axisRow"/>', '<pivotField axis="axisRow" autoShow="1"/>')], 'unsupported_pivot_layout'),
            ([('pivot', '<pivotField axis="axisRow"/>', '<pivotField axis="axisRow" sortType="ascending"/>')], 'unsupported_pivot_layout'),
            ([('xl/_rels/workbook.xml.rels', '</Relationships>', '<Relationship Type="example/connections" Target="customConnections.xml"/></Relationships>')], 'unsupported_pivot_source'),
            ([('[Content_Types].xml', '<Types/>', '<Types><Override PartName="/xl/customConnections.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.connections+xml"/></Types>')], 'unsupported_pivot_source'),
            ([('cache', '<cacheField name="Quantity">', '<cacheField name="Quantity" formula="1+2">')], 'unsupported_pivot_layout'),
        ]:
            self.rejected(code, pivot_features, pivot_seed(changes))
        self.assertEqual(len(pivot_features(pivot_seed([('pivot', 'subtotal="sum"', 'subtotal="sum" numFmtId="164"')]))), 1)

    @unittest.skipUnless(sys.platform == "linux", "Linux process groups and seccomp")
    def test_network_sandbox_is_inherited(self):
        script = '''from sandbox import deny_ip_network
import ctypes,errno,socket,subprocess,sys
deny_ip_network()
for domain in (socket.AF_INET,socket.AF_INET6):
 try: socket.socket(domain); raise AssertionError('network allowed')
 except PermissionError: pass
s=socket.socket(socket.AF_UNIX);s.close()
libc=ctypes.CDLL(None,use_errno=True)
for number in (425,426,427):
 assert libc.syscall(number,0,0,0,0,0,0)==-1 and ctypes.get_errno()==errno.EPERM
subprocess.run([sys.executable,'-c','import socket; socket.socket(socket.AF_INET)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False).returncode == 0 and sys.exit(2)
'''
        result = subprocess.run([sys.executable, "-c", script], env={**os.environ, "PYTHONPATH": str(ROOT / "runtime/office")}, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(sys.platform == "linux", "Linux process groups")
    def test_timeout_kills_descendant_and_removes_profile(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            worker = root / "stuck.py"
            pidfile = root / "child.pid"
            worker.write_text("import pathlib,subprocess,sys,time\n"
                              "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(300)'])\n"
                              f"pathlib.Path({str(pidfile)!r}).write_text(str(p.pid))\n"
                              "time.sleep(300)\n")
            jobs = root / "jobs"
            jobs.mkdir()
            engine = Engine(timeout=1, worker=worker, temp_root=jobs)
            self.rejected("engine_timeout", engine.execute, body(), False)
            self.assertEqual(list(jobs.iterdir()), [])
            pid = int(pidfile.read_text())
            # SIGKILL can be pending while the child has not yet been scheduled.
            # Require termination within a bound, not an immediate /proc snapshot.
            status = Path(f"/proc/{pid}/status")
            for _ in range(100):
                try:
                    if "Z (zombie)" in status.read_text():
                        break
                except FileNotFoundError:
                    break
                time.sleep(0.02)
            else:
                self.fail("Timed-out descendant remained alive")


class HTTP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class NoEngine:
            def execute(self, value, transform):
                request(value, transform)
                raise RuntimeError("private-document-token-do-not-log")
        class FastInputHandler(Handler):
            input_timeout = 0.35
        cls.server = Server(("127.0.0.1", 0), partial(FastInputHandler, engine=NoEngine()))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def call(self, payload, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        connection.request("POST", "/inspect", payload, headers or {"Content-Type": "application/json"})
        result = connection.getresponse()
        status, content = result.status, result.read()
        connection.close()
        return status, json.loads(content)

    def test_duplicate_keys_and_error_redaction(self):
        self.assertEqual(self.call('{"format":"docx","format":"pptx"}')[0], 400)
        status, result = self.call(json.dumps(body()))
        self.assertEqual(status, 500)
        self.assertEqual(result, {"error": {"code": "engine_failed"}})

    def test_busy_rejects_without_waiting(self):
        Handler.slot.acquire()
        try:
            self.assertEqual(self.call(json.dumps(body())), (503, {"error": {"code": "busy"}}))
        finally:
            Handler.slot.release()

    def test_header_limits_and_health(self):
        self.assertEqual(self.call("{}", {"Content-Type": "text/plain"})[0], 400)
        self.assertEqual(self.call("{}", {"Content-Type": "application/json", "Content-Length": "99999999"})[0], 413)
        self.assertEqual(self.call("{}", {"Content-Type": "application/json", "Transfer-Encoding": "chunked"})[0], 400)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        connection.request("GET", "/health")
        result = connection.getresponse()
        self.assertEqual(result.status, 200)
        self.assertEqual(json.loads(result.read())["protocol"], "office-batch/v1")
        connection.close()

    def test_slow_body_has_total_deadline(self):
        with socket.create_connection(("127.0.0.1", self.server.server_port), timeout=3) as connection:
            start = time.monotonic()
            connection.sendall(b"POST /inspect HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n")
            for _ in range(3):
                connection.sendall(b" ")
                time.sleep(0.1)
            response = connection.recv(4096)
            self.assertIn(b" 408 ", response)
            self.assertLess(time.monotonic() - start, 2)


if __name__ == "__main__":
    unittest.main()
