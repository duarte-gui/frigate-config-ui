#!/usr/bin/env python3
"""Frigate UI — static server + API proxy. Stdlib only."""
import http.server
import urllib.request
import urllib.error
import socketserver
import subprocess
import json
import sys
from pathlib import Path

FRIGATE_URL = "http://127.0.0.1:5000"
PORT = 8000
STATIC_DIR = Path(__file__).parent


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def _proxy(self, method):
        target = FRIGATE_URL + self.path
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(target, data=body, method=method)
        for h in ("Content-Type", "Accept"):
            v = self.headers.get(h)
            if v:
                req.add_header(h, v)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    if k.lower() in ("transfer-encoding", "connection", "content-encoding"):
                        continue
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(resp.read())
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(f"Proxy error: {e}".encode())

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self._proxy("GET")
        return super().do_GET()

    def _restart_go2rtc(self):
        # Frigate's /api/restart restarts only the frigate service, NOT go2rtc.
        # go2rtc re-reads its streams (frigate.yml -> /dev/shm/go2rtc.yaml) only
        # when its own systemd unit restarts. Without this, stream edits never apply.
        try:
            subprocess.run(
                ["systemctl", "restart", "go2rtc"],
                check=True, capture_output=True, timeout=30,
            )
            payload, code = {"success": True, "message": "go2rtc reiniciado"}, 200
        except Exception as e:
            payload, code = {"success": False, "message": str(e)}, 500
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.startswith("/api/"):
            return self._proxy("POST")
        if self.path == "/restart-go2rtc":
            return self._restart_go2rtc()
        self.send_error(405)

    def do_PUT(self):
        if self.path.startswith("/api/"):
            return self._proxy("PUT")
        self.send_error(405)

    def end_headers(self):
        # Sem Cache-Control o navegador aplica cache heuristico: como o
        # Last-Modified de um arquivo recem-instalado pode ser antigo, ele
        # considera o app.js fresco por meses e nem revalida. Na pratica uma
        # atualizacao do editor so aparecia depois de um reload forcado, e a
        # combinacao "index.html novo + app.js velho" quebra a pagina.
        # As respostas do proxy ficam de fora: quem manda nelas e o Frigate.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[{self.log_date_time_string()}] {fmt % args}\n")


class Server(socketserver.ThreadingTCPServer):
    # Sem SO_REUSEADDR, um socket ainda em TIME_WAIT faz o bind falhar com
    # "Address already in use", e como a unidade tem Restart=on-failure isso
    # vira um loop de reinicios ate o kernel liberar a porta.
    allow_reuse_address = True
    # Conexoes keep-alive do navegador seguravam threads vivas e atrasavam o
    # desligamento; como thread daemon elas nao impedem o processo de sair.
    daemon_threads = True


if __name__ == "__main__":
    with Server(("0.0.0.0", PORT), Handler) as httpd:
        print(f"Frigate UI → http://localhost:{PORT}  (proxy → {FRIGATE_URL})")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
