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
            # A just-killed child may be a zombie briefly until container init reaps it.
            status = Path(f"/proc/{pid}/status")
            if status.exists():
                self.assertIn("Z (zombie)", status.read_text())


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
