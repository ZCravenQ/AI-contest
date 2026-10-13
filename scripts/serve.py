#!/usr/bin/env python3
"""余讯 6.1 本地静态服务器；仅依赖 Python 标准库。"""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent.parent / "public"


def resolve_asset(request_path, root=ROOT):
    try:
        path = unquote(urlsplit(request_path).path, errors="strict")
        if "\x00" in path or "\\" in path:
            return None
        target = (root / path.lstrip("/")).resolve()
        target.relative_to(root.resolve())
        return target
    except (ValueError, UnicodeDecodeError, OSError):
        return None


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".svg": "image/svg+xml",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
    }

    def translate_path(self, path):
        resolved = resolve_asset(path)
        return str(resolved) if resolved is not None else str(ROOT / "__invalid_path__")

    def send_head(self):
        target = resolve_asset(self.path)
        if target is None:
            self.send_error(400, "Invalid path")
            return None
        if target.is_dir():
            index = target / "index.html"
            try:
                index.resolve().relative_to(ROOT.resolve())
            except (ValueError, OSError):
                self.send_error(404, "File not found")
                return None
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404, "File not found")
        return None

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()


def main():
    try:
        server = ThreadingHTTPServer(("127.0.0.1", 8080), partial(Handler, directory=str(ROOT)))
    except OSError as error:
        print("启动失败：请检查 8080 端口是否已被占用。", error)
        return 1
    print("余讯 6.1 已启动：http://127.0.0.1:8080", flush=True)
    print("请在浏览器中打开以上地址。关闭本窗口或按 Ctrl+C 停止。", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
