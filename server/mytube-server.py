#!/usr/bin/env python3
"""
mytube audio server
--------------------
Given a YouTube videoId, extract the best m4a audio stream with yt-dlp and
proxy the bytes to the client (forwarding Range requests so seeking works).

Why proxy instead of returning the URL directly?
  googlevideo URLs are locked to the IP that extracted them, so the phone (on
  LTE / different Wi-Fi) can't play them. Streaming through this server, whose
  IP matches, works from anywhere.

Run:
    python mytube-server.py            # listens on 0.0.0.0:8080
    PORT=9000 python mytube-server.py  # custom port

Endpoints:
    GET  /health          -> {"ok": true}
    GET  /audio/<videoId> -> audio/mp4 stream (supports Range)
    POST /browse          -> proxies YouTube's continuation API so the app's
                             "더 보기" list can page past the first ~30 videos
                             (body: {apiKey, clientVersion, continuation})
"""

import os
import re
import sys
import json
import time
import socketserver
import subprocess
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("PORT", "8080"))
CACHE_TTL = 5 * 3600            # googlevideo URLs live ~6h; refresh a bit early
EXTRACT_TIMEOUT = 90           # seconds for yt-dlp
FORMAT = "ba[ext=m4a]/bestaudio[ext=m4a]/bestaudio"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_cache = {}  # videoId -> (url, expiry_epoch)


def extract_audio_url(video_id, force=False):
    """Return a direct googlevideo m4a URL for the given videoId (cached)."""
    now = time.time()
    if not force:
        hit = _cache.get(video_id)
        if hit and hit[1] > now:
            return hit[0]

    cmd = [sys.executable, "-m", "yt_dlp",
           "-f", FORMAT, "-g", "--no-playlist", "--no-warnings"]
    # A JS runtime (e.g. node/deno) lets yt-dlp solve YouTube's signature
    # challenge, avoiding throttled/missing formats. Optional but recommended.
    js_runtime = os.environ.get("YTDLP_JS_RUNTIME")
    if js_runtime:
        cmd += ["--js-runtimes", js_runtime]
    cmd.append(f"https://www.youtube.com/watch?v={video_id}")

    proc = subprocess.run(
        cmd, capture_output=True, text=True, timeout=EXTRACT_TIMEOUT,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        raise RuntimeError((proc.stderr or "extraction failed").strip()[:300])

    url = proc.stdout.strip().splitlines()[0]
    _cache[video_id] = (url, now + CACHE_TTL)
    return url


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header("Access-Control-Expose-Headers",
                         "Content-Range, Accept-Ranges, Content-Length")

    def _simple(self, code, body=b"", ctype="text/plain"):
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        # Proxy YouTube's internal continuation API (POST-only, JSON) so the app
        # can page past the first ~30 videos in the "더 보기" list. Browsers and
        # public CORS proxies can't do this POST (preflight + YouTube rejects it
        # from datacenter IPs); this server can, from its residential IP.
        if urlparse(self.path).path != "/browse":
            self._simple(404, b"not found")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            req = json.loads(raw or b"{}")
        except Exception:
            self._simple(400, b"bad json")
            return

        api_key = req.get("apiKey", "") or ""
        continuation = req.get("continuation", "") or ""
        client_version = req.get("clientVersion", "") or "2.20240101.00.00"
        if not continuation or not re.match(r"^[A-Za-z0-9_-]+$", api_key):
            self._simple(400, b"missing/invalid params")
            return

        yt_url = "https://www.youtube.com/youtubei/v1/browse?key=" + api_key
        payload = json.dumps({
            "context": {"client": {"clientName": "WEB",
                                   "clientVersion": client_version,
                                   "hl": "ko", "gl": "KR"}},
            "continuation": continuation,
        }).encode()
        try:
            r = urllib.request.urlopen(
                urllib.request.Request(
                    yt_url, data=payload,
                    headers={"Content-Type": "application/json", "User-Agent": UA}),
                timeout=30)
            data = r.read()
        except Exception as e:
            self._simple(502, ("browse error: %s" % e).encode())
            return

        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/health":
            self._simple(200, b'{"ok":true}', "application/json")
            return

        m = re.match(r"^/audio/([^/]+)$", path)
        if not m or not VIDEO_ID_RE.match(m.group(1)):
            self._simple(404, b"not found")
            return
        video_id = m.group(1)

        # Resolve the upstream URL, retrying once with a fresh extraction if the
        # cached URL has expired (403/410 from googlevideo).
        try:
            upstream = self._open_upstream(video_id, force=False)
        except _Expired:
            try:
                upstream = self._open_upstream(video_id, force=True)
            except Exception as e:
                self._simple(502, f"upstream error: {e}".encode())
                return
        except Exception as e:
            self._simple(502, f"extract error: {e}".encode())
            return

        # Relay status + headers, then stream the body.
        self.send_response(upstream.status)  # 200 or 206
        self._cors()
        passthrough = ("Content-Type", "Content-Length", "Content-Range")
        for h in passthrough:
            v = upstream.headers.get(h)
            if v:
                self.send_header(h, v)
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()

        try:
            while True:
                chunk = upstream.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # client seeked or navigated away; not an error
        finally:
            upstream.close()

    def _open_upstream(self, video_id, force):
        audio_url = extract_audio_url(video_id, force=force)
        headers = {"User-Agent": UA}
        rng = self.headers.get("Range")
        if rng:
            headers["Range"] = rng
        try:
            return urllib.request.urlopen(
                urllib.request.Request(audio_url, headers=headers), timeout=30)
        except urllib.error.HTTPError as e:
            if e.code in (403, 410) and not force:
                _cache.pop(video_id, None)
                raise _Expired()
            raise

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class _Expired(Exception):
    pass


class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"mytube audio server listening on 0.0.0.0:{PORT}", flush=True)
    print(f"  health check:  http://localhost:{PORT}/health", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down", flush=True)
        server.shutdown()


if __name__ == "__main__":
    main()
