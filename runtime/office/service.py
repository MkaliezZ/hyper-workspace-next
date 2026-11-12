"""Private single-flight Office HTTP service. No input or engine logging."""
import base64
from functools import partial
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
from threading import BoundedSemaphore, Lock
import time

from validation import ENGINE, MAX_FILE, MAX_JSON, PROTOCOL, Rejected, package, request

TIMEOUT = 60


class Engine:
    def __init__(self, *, timeout=TIMEOUT, worker=None, temp_root=None):
        self.timeout = timeout
        self.worker = worker or Path(__file__).with_name("worker.py")
        self.temp_root = temp_root

    def execute(self, body, transform):
        data, digest = request(body, transform)
        with tempfile.TemporaryDirectory(prefix="hyper-office-", dir=self.temp_root) as temporary:
            directory = Path(temporary)
            (directory / ("source." + body["format"])).write_bytes(data)
            (directory / "job.json").write_text(json.dumps({"format": body["format"], "transform": transform,
                                                         "operations": body.get("operations", [])}))
            environment = {key: value for key, value in os.environ.items() if key in (
                "PATH", "LD_LIBRARY_PATH", "URE_BOOTSTRAP", "PYTHONHOME", "PYTHONPATH", "SAL_USE_VCLPLUGIN", "LANG")}
            environment.update(HOME=temporary, TMPDIR=temporary, PYTHONDONTWRITEBYTECODE="1")
            process = subprocess.Popen([sys.executable, str(self.worker), str(directory)], env=environment,
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       start_new_session=True, close_fds=True)
            try:
                try:
                    process.wait(timeout=self.timeout)
                except subprocess.TimeoutExpired:
                    raise Rejected("engine_timeout", 504) from None
                result_path = directory / "result.json"
                if process.returncode or not result_path.is_file() or result_path.stat().st_size > MAX_JSON:
                    raise Rejected("engine_failed", 500)
                result = json.loads(result_path.read_text())
                if "error" in result:
                    raise Rejected(result["error"]["code"], result["error"]["status"])
                response = {"protocol": PROTOCOL, "engine": ENGINE, "format": body["format"], "sourceSha256": digest, **result}
                if transform:
                    output = directory / ("output." + body["format"])
                    if not output.is_file() or output.stat().st_size > MAX_FILE:
                        raise Rejected("output_limit", 413)
                    content = output.read_bytes()
                    package(content, body["format"])
                    response.update(contentBase64=base64.b64encode(content).decode(), outputSha256=hashlib.sha256(content).hexdigest())
                return response
            finally:
                # Also reap leftover soffice descendants if the client failed or exited early.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


class Handler(BaseHTTPRequestHandler):
    timeout = 10
    input_timeout = 10
    server_version = "HyperOffice"
    slot = Lock()

    def __init__(self, *args, engine, **kwargs):
        self.engine = engine
        super().__init__(*args, **kwargs)

    def log_message(self, *_args):
        pass

    def send_error(self, code, message=None, explain=None):
        # BaseHTTPRequestHandler otherwise embeds the raw request line in HTML.
        self.reply(code, {"error": {"code": "invalid_http"}})

    def reply(self, status, payload):
        content = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        if status == 503:
            self.send_header("Retry-After", "1")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"status": "ok", "protocol": PROTOCOL, "engine": ENGINE})
        else:
            self.reply(404, {"error": {"code": "unknown_route"}})

    def do_POST(self):
        if self.path not in ("/inspect", "/transform"):
            self.reply(404, {"error": {"code": "unknown_route"}})
            return
        length = self.headers.get("Content-Length", "")
        if (self.headers.get_content_type() != "application/json" or self.headers.get("Transfer-Encoding")
                or len(self.headers.get_all("Content-Length", [])) != 1 or not re.fullmatch(r"[1-9][0-9]{0,8}", length)):
            self.reply(400, {"error": {"code": "invalid_headers"}})
            return
        if int(length) > MAX_JSON:
            self.reply(413, {"error": {"code": "request_limit"}})
            return
        if not self.slot.acquire(blocking=False):
            self.reply(503, {"error": {"code": "busy"}})
            return
        try:
            deadline = time.monotonic() + self.input_timeout
            content = bytearray()
            while len(content) < int(length):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                self.connection.settimeout(remaining)
                chunk = self.rfile.read1(min(65536, int(length) - len(content)))
                if not chunk:
                    raise Rejected("incomplete_request", 400)
                content.extend(chunk)
            self.connection.settimeout(self.timeout)
            try:
                body = json.loads(content, object_pairs_hook=unique_object,
                                  parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()))
            except (ValueError, UnicodeError, RecursionError):
                raise Rejected("invalid_json", 400) from None
            result = self.engine.execute(body, self.path == "/transform")
        except Rejected as error:
            self.reply(error.status, {"error": {"code": error.code}})
        except TimeoutError:
            self.reply(408, {"error": {"code": "input_timeout"}})
        except Exception:
            self.reply(500, {"error": {"code": "engine_failed"}})
        else:
            self.reply(200, result)
        finally:
            self.slot.release()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8
    connections = BoundedSemaphore(16)

    def process_request(self, request_socket, client_address):
        if not self.connections.acquire(blocking=False):
            self.shutdown_request(request_socket)
            return
        try:
            super().process_request(request_socket, client_address)
        except Exception:
            self.connections.release()
            raise

    def process_request_thread(self, request_socket, client_address):
        try:
            super().process_request_thread(request_socket, client_address)
        finally:
            self.connections.release()

    def handle_error(self, *_args):
        pass


if __name__ == "__main__":
    os.umask(0o077)
    with Server((os.getenv("HYPER_OFFICE_BIND_HOST", "127.0.0.1"), 3123), partial(Handler, engine=Engine())) as server:
        server.serve_forever()
