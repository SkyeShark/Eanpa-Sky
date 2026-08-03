#!/usr/bin/env python3
"""Static dev server with a console-log intake endpoint.

Serves the project directory like http.server, and accepts POST /__log
(JSON lines from the page's forwarded console/errors), appending them to
artifacts/debug/browser-console.log so the assistant can read the page's
console without the user copying anything.
"""

import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG_PATH = ROOT / "artifacts" / "debug" / "browser-console.log"
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/__log":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0) or 0)
        payload = self.rfile.read(min(length, 65536))
        with LOG_PATH.open("ab") as handle:
            handle.write(payload.rstrip(b"\n") + b"\n")
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"eanpa dev server on http://127.0.0.1:{port}/ (log intake /__log)")
    server.serve_forever()


if __name__ == "__main__":
    main()
