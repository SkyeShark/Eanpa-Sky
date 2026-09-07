#!/usr/bin/env python3
"""Loopback-only static server and bounded browser-console log intake."""
import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG_PATH = ROOT / 'artifacts/debug/browser-console.log'


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript',
                      '.wasm': 'application/wasm'}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        if self.command in ('GET', 'HEAD'):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        if self.path != '/__log':
            self.send_error(404)
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            self.send_error(400)
            return
        if not 0 <= size <= 65536:
            self.send_error(413)
            return
        payload = self.rfile.read(size)
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open('ab') as handle:
            handle.write(payload.rstrip(b'\n') + b'\n')
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8378
    server = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'Eanpa: http://127.0.0.1:{port}/', flush=True)
    server.serve_forever()
