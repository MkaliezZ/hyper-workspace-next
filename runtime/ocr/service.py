"""Private HTTP adapter for the local CPU OCR models."""
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import sys
from threading import Lock

from page import IMAGE_FORMATS, InvalidPage, MAX_BYTES
from recognizer import Recognizer


class Handler(BaseHTTPRequestHandler):
    timeout = 10
    server_version = "HyperOCR"
    recognition_slot = Lock()

    def __init__(self, *args, engine, **kwargs):
        self.engine = engine
        super().__init__(*args, **kwargs)

    def log_message(self, _format, *_args):
        pass

    def reply(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"status": "ok"})
        else:
            self.reply(404, {"error": "Unknown route"})

    def do_POST(self):
        if self.path != "/recognize":
            self.reply(404, {"error": "Unknown route"})
            return
        mime = self.headers.get("Content-Type", "")
        page = self.headers.get("X-OCR-Page", "")
        length = self.headers.get("Content-Length", "")
        if (
            mime not in (*IMAGE_FORMATS, "application/pdf")
            or not re.fullmatch(r"[1-9][0-9]?", page)
            or not 1 <= int(page) <= 50
            or self.headers.get("Transfer-Encoding")
            or not re.fullmatch(r"[1-9][0-9]{0,6}", length)
            or int(length) > MAX_BYTES
        ):
            self.reply(422, {"error": "Unsupported page or input format"})
            return

        if not self.recognition_slot.acquire(blocking=False):
            self.reply(503, {"error": "OCR is processing another page"})
            return
        try:
            data = self.rfile.read(int(length))
            if len(data) != int(length):
                raise InvalidPage("Incomplete request")
            result = self.engine.recognize(data, mime, int(page))
        except InvalidPage:
            self.reply(422, {"error": "The selected page could not be recognized"})
        except TimeoutError:
            self.reply(408, {"error": "Input read timed out"})
        except Exception as error:
            print(f"OCR processing failed ({type(error).__name__})", file=sys.stderr, flush=True)
            self.reply(500, {"error": "Recognition failed"})
        else:
            self.reply(200, result)
        finally:
            self.recognition_slot.release()


def main():
    models = Path(os.environ["HYPER_OCR_MODELS"])
    engine = Recognizer(models)
    host = os.getenv("HYPER_OCR_BIND_HOST", "127.0.0.1")
    with ThreadingHTTPServer((host, 3122), partial(Handler, engine=engine)) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
