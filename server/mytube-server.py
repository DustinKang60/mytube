#!/usr/bin/env python3
"""
mytube audio server
--------------------
Downloads a YouTube track's m4a audio to a local disk cache using many
parallel range requests, then serves that finished local file to the app.

Why download instead of proxying the stream?
  googlevideo throttles each connection to roughly real-time (~30 KB/s), so a
  single proxied stream can never buffer ahead of playback. Mobile browsers
  suspend background network once the screen is off, so playback died about
  two minutes in — as soon as the small buffer drained. The throttle is per
  connection, so fetching ~16 ranges at once beats it (measured ~5.5 MB/s: a
  64.9 MB one-hour clip in 12s). The app then downloads the whole finished
  file into memory and plays it from a Blob, needing no network afterwards —
  which is what makes screen-off playback survive.

Why serve the bytes at all, instead of handing over the googlevideo URL?
  Those URLs are locked to the IP that extracted them, so the phone (on LTE /
  another Wi-Fi) can't use them. Serving from this server, whose IP matches,
  works from anywhere.

Run:
    python mytube-server.py            # listens on 0.0.0.0:8080
    PORT=9000 python mytube-server.py  # custom port

Environment:
    PORT                 listen port (default 8080)
    MYTUBE_DL_CONNS      parallel range connections per download (default 16)
    MYTUBE_CACHE_DIR     cache location (default ~/mytube-server/audio-cache)
    MYTUBE_CACHE_MAX_MB  cache cap in MB, LRU-evicted (default 4096)
    YTDLP_JS_RUNTIME     e.g. "node" — lets yt-dlp solve YouTube's signature
                         challenge; optional but improves extraction

Endpoints:
    GET  /health          -> {"ok": true}
    GET  /audio/<videoId> -> audio/mp4 of the whole track (supports Range).
                             First request downloads + caches it (so it blocks
                             for the download); later requests are served from
                             disk. Falls back to slow direct streaming if the
                             parallel download fails.
    GET  /fetch?url=...   -> relays a YouTube page/RSS feed from this server's
                             residential IP (host-allowlisted to YouTube, so
                             the public tunnel never becomes an open proxy).
                             The app prefers this over flaky public CORS proxies.
    POST /browse          -> proxies YouTube's continuation API so the app's
                             "더 보기" list can page past the first ~30 videos
                             (body: {apiKey, clientVersion, continuation})

Note: live streams don't work — yt-dlp can't produce an m4a for them
("Requested format is not available"), and the app doesn't support them.
"""

import os
import re
import sys
import json
import time
import errno
import shutil
import threading
import socketserver
import subprocess
import urllib.request
import urllib.error
import concurrent.futures
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", "8080"))
CACHE_TTL = 5 * 3600            # googlevideo URLs live ~6h; refresh a bit early
EXTRACT_TIMEOUT = 90           # seconds for yt-dlp
FORMAT = "ba[ext=m4a]/bestaudio[ext=m4a]/bestaudio"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
# /fetch only relays these hosts — the tunnel is public, so never be an open proxy.
ALLOWED_FETCH_HOSTS = {"www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"}
_cache = {}  # videoId -> (url, expiry_epoch)

# ---------------------------------------------------------------------------
#  On-disk audio cache
#  googlevideo throttles each connection to ~real-time (~30 KB/s), so a single
#  streamed connection can never get ahead of playback — which is why phone
#  playback dies a couple minutes after the screen goes off (the browser stops
#  fetching in the background and the small buffer drains). The throttle is
#  PER CONNECTION, though, so we download each track with many parallel range
#  requests (≈ N × 30 KB/s), save the finished file to disk, and serve that
#  local file. A complete local file downloads to the phone fast enough that it
#  can hold the whole track and keep playing with the screen off.
# ---------------------------------------------------------------------------
CACHE_DIR = os.environ.get(
    "MYTUBE_CACHE_DIR",
    os.path.join(os.path.expanduser("~"), "mytube-server", "audio-cache"),
)
CACHE_MAX_BYTES = int(os.environ.get("MYTUBE_CACHE_MAX_MB", "4096")) * 1024 * 1024
DL_CONNS = int(os.environ.get("MYTUBE_DL_CONNS", "16"))   # parallel range fetches
DL_CHUNK = 256 * 1024                                     # per-read block size
DL_CONN_TIMEOUT = 300                                     # seconds per connection

os.makedirs(CACHE_DIR, exist_ok=True)
_dl_locks_guard = threading.Lock()
_dl_locks = {}  # videoId -> threading.Lock (one download per id at a time)


def _cache_path(video_id):
    return os.path.join(CACHE_DIR, video_id + ".m4a")


def _dl_lock_for(video_id):
    with _dl_locks_guard:
        lock = _dl_locks.get(video_id)
        if lock is None:
            lock = threading.Lock()
            _dl_locks[video_id] = lock
        return lock


def _evict_cache():
    """Keep the cache under CACHE_MAX_BYTES, deleting least-recently-used files."""
    try:
        files = []
        total = 0
        for name in os.listdir(CACHE_DIR):
            if not name.endswith(".m4a"):
                continue
            p = os.path.join(CACHE_DIR, name)
            try:
                st = os.stat(p)
            except OSError:
                continue
            files.append((st.st_atime, st.st_size, p))
            total += st.st_size
        files.sort()  # oldest access first
        for _atime, size, p in files:
            if total <= CACHE_MAX_BYTES:
                break
            try:
                os.remove(p)
                total -= size
            except OSError:
                pass
    except OSError:
        pass


def _fetch_range(url, start, end, fd):
    """Download bytes [start, end] of url and pwrite them at their offset."""
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Range": f"bytes={start}-{end}"})
    with urllib.request.urlopen(req, timeout=DL_CONN_TIMEOUT) as r:
        pos = start
        while True:
            block = r.read(DL_CHUNK)
            if not block:
                break
            os.pwrite(fd, block, pos)
            pos += len(block)
    return pos - start


def _parallel_download(url, dest_path, total):
    """Download `total` bytes of `url` into dest_path using DL_CONNS ranges."""
    part = dest_path + ".part"
    fd = os.open(part, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        os.ftruncate(fd, total)
        n = max(1, DL_CONNS)
        seg = (total + n - 1) // n
        ranges = []
        for i in range(n):
            start = i * seg
            if start >= total:
                break
            end = min(start + seg, total) - 1
            ranges.append((start, end))
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(ranges)) as ex:
            futs = [ex.submit(_fetch_range, url, s, e, fd) for (s, e) in ranges]
            for f in concurrent.futures.as_completed(futs):
                f.result()  # re-raise any worker error
        os.close(fd)
        fd = -1
        os.replace(part, dest_path)
    finally:
        if fd != -1:
            os.close(fd)
        if os.path.exists(part):
            try:
                os.remove(part)
            except OSError:
                pass


def ensure_cached(video_id):
    """Return the local path for video_id, downloading it (fast, parallel) first
    if it isn't already on disk. Raises on failure so the caller can fall back."""
    path = _cache_path(video_id)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        os.utime(path, None)  # mark recently used for LRU eviction
        return path

    lock = _dl_lock_for(video_id)
    with lock:
        # Another request may have finished the download while we waited.
        if os.path.exists(path) and os.path.getsize(path) > 0:
            os.utime(path, None)
            return path

        url = extract_audio_url(video_id)
        # Ask for one byte to learn the total size and confirm Range support.
        head_req = urllib.request.Request(
            url, headers={"User-Agent": UA, "Range": "bytes=0-0"})
        try:
            with urllib.request.urlopen(head_req, timeout=30) as r:
                crange = r.headers.get("Content-Range", "")  # bytes 0-0/12345
        except urllib.error.HTTPError as e:
            if e.code in (403, 410):
                url = extract_audio_url(video_id, force=True)
                with urllib.request.urlopen(
                        urllib.request.Request(url, headers={"User-Agent": UA, "Range": "bytes=0-0"}),
                        timeout=30) as r:
                    crange = r.headers.get("Content-Range", "")
            else:
                raise
        total = int(crange.rsplit("/", 1)[-1]) if "/" in crange else 0
        if total <= 0:
            raise RuntimeError("could not determine audio size for parallel download")

        t0 = time.time()
        _parallel_download(url, path, total)
        dt = time.time() - t0
        mb = total / (1024 * 1024)
        sys.stderr.write(
            f"[cache] {video_id}: {mb:.1f}MB in {dt:.0f}s "
            f"({mb / dt:.2f} MB/s, {DL_CONNS} conns)\n")
        _evict_cache()
        return path


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
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/health":
            self._simple(200, b'{"ok":true}', "application/json")
            return

        # GET /fetch?url=<youtube url> — relay a YouTube page/feed from this
        # server's residential IP. The app uses this instead of the flaky public
        # CORS proxies whenever a server is configured.
        if path == "/fetch":
            self._do_fetch(parse_qs(parsed.query).get("url", [""])[0])
            return

        m = re.match(r"^/audio/([^/]+)$", path)
        if not m or not VIDEO_ID_RE.match(m.group(1)):
            self._simple(404, b"not found")
            return
        video_id = m.group(1)

        # Cache-first: download the whole track fast (parallel range requests)
        # to disk, then serve that local file. A complete local file transfers
        # to the phone quickly enough to keep playing with the screen off.
        try:
            local_path = ensure_cached(video_id)
            self._serve_local_file(local_path)
            return
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return  # client went away mid-transfer; not an error
        except Exception as e:
            sys.stderr.write(f"[cache] {video_id} failed ({e}) — proxy fallback\n")

        # Fallback: if the parallel download failed, stream directly from
        # googlevideo (slow, and no reliable screen-off playback, but at least
        # something plays).
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

    def _serve_local_file(self, path):
        """Serve a complete local audio file, honouring a Range request."""
        size = os.path.getsize(path)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        partial = False
        if rng:
            mrange = re.match(r"bytes=(\d*)-(\d*)", rng)
            if mrange:
                gs, ge = mrange.group(1), mrange.group(2)
                if gs:
                    start = int(gs)
                    end = int(ge) if ge else size - 1
                elif ge:  # suffix range: last N bytes
                    start = max(0, size - int(ge))
                start = min(start, size - 1)
                end = min(end, size - 1)
                partial = True

        length = end - start + 1
        self.send_response(206 if partial else 200)
        self._cors()
        self.send_header("Content-Type", "audio/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()

        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                block = f.read(min(64 * 1024, remaining))
                if not block:
                    break
                self.wfile.write(block)
                remaining -= len(block)

    def _do_fetch(self, raw_url):
        # This server is reachable from the public internet through the tunnel,
        # so only ever relay YouTube — never become an open proxy.
        if not raw_url:
            self._simple(400, b"missing url")
            return
        try:
            host = (urlparse(raw_url).hostname or "").lower()
        except Exception:
            self._simple(400, b"bad url")
            return
        if not (host in ALLOWED_FETCH_HOSTS or host.endswith(".youtube.com")):
            self._simple(403, b"host not allowed")
            return

        try:
            r = urllib.request.urlopen(
                urllib.request.Request(raw_url, headers={
                    "User-Agent": UA,
                    "Accept-Language": "ko-KR,ko;q=0.9",
                }), timeout=30)
            body = r.read()
        except Exception as e:
            self._simple(502, ("fetch error: %s" % e).encode())
            return

        self.send_response(200)
        self._cors()
        ctype = r.headers.get("Content-Type", "text/plain")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
