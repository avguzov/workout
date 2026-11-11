#!/usr/bin/env python3
"""Run the engine tests in headless Edge and print the results.

Usage, from app/:  python tools/run_tests.py

Serves app/ on a free 127.0.0.1 port, opens /tests/index.html in headless Edge with a
temporary profile, waits up to 180 seconds for the page to POST its results to /__results,
prints one line per test, the matrix and coverage tables, and a TOTAL line.

Exit codes: 0 all tests passed, 1 some test failed, 2 timed out waiting for results,
3 Edge not found. Standard library only. Set EDGE_PATH to override the Edge location.
"""

import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from functools import partial
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
TIMEOUT_SEC = 180
MIME = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
}


def find_edge():
    env = os.environ.get("EDGE_PATH")
    if env:
        return env if Path(env).is_file() else None
    roots = [
        os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
        os.environ.get("ProgramFiles", r"C:\Program Files"),
        r"C:\Program Files (x86)",
        r"C:\Program Files",
    ]
    for root in roots:
        p = Path(root) / "Microsoft" / "Edge" / "Application" / "msedge.exe"
        if p.is_file():
            return str(p)
    return None


class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        ext = os.path.splitext(str(path))[1].lower()
        return MIME.get(ext) or super().guess_type(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    def do_POST(self):
        if self.path != "/__results":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        try:
            data = json.loads(body.decode("utf-8"))
        except Exception as exc:  # malformed payload still ends the run
            data = {"results": [{"name": "results payload", "ok": False, "message": str(exc)}], "reports": {}}
        self.send_response(204)
        self.end_headers()
        self.server.results = data
        self.server.done.set()


def kill_edge(proc, profile_dir):
    """Stop our Edge and any child still using our temporary profile. Other Edge windows are left alone."""
    if proc is not None and proc.poll() is None:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if proc is not None:
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
    marker = str(profile_dir).replace("'", "''")
    query = (
        "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | "
        "Where-Object { $_.CommandLine -and $_.CommandLine.Contains('" + marker + "') } | "
    )
    kill = query + "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }"
    look = query + "ForEach-Object { $_.ProcessId }"

    def ps(script):
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                           capture_output=True, text=True)
        return " ".join(r.stdout.split())

    for _ in range(6):
        if not ps(kill):
            return ""
        time.sleep(1)
    return ps(look)


def remove_profile(profile_dir):
    for _ in range(10):
        shutil.rmtree(profile_dir, ignore_errors=True)
        if not Path(profile_dir).exists():
            return True
        time.sleep(0.5)
    return False


def fmt_cell(v):
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:.1f}"
    return str(v)


def print_table(headers, rows):
    widths = [len(h) for h in headers]
    for row in rows:
        for i, v in enumerate(row):
            widths[i] = max(widths[i], len(fmt_cell(v)))
    line = "  ".join(h.ljust(widths[i]) for i, h in enumerate(headers))
    print(line)
    print("  ".join("-" * w for w in widths))
    for row in rows:
        print("  ".join(fmt_cell(v).ljust(widths[i]) for i, v in enumerate(row)))


def print_reports(reports):
    matrix = reports.get("matrix") or []
    if matrix:
        print()
        print("MATRIX (25 consecutive sessions per cell)")
        cols = ["profile", "length_min", "sessions", "violations", "off_target", "forced_repeat",
                "adjusted", "over_length", "avg_min"]
        print_table(["profile", "min", "sessions", "violations", "off_target", "forced_repeat",
                     "adjusted", "over_length", "avg_est_min"],
                    [[c.get(k) for k in cols] for c in matrix])
        tot = {k: sum(c.get(k) or 0 for c in matrix) for k in cols[2:-1]}
        print("all cells: " + ", ".join(f"{k} {v}" for k, v in tot.items()))
    cov = reports.get("coverage")
    if cov:
        print()
        print(f"COVERAGE ({cov.get('sessions')} sessions, {cov.get('profile')}, {cov.get('length_min')} min): "
              f"{cov.get('movements_seen')}/{cov.get('movements_eligible')} eligible movements used"
              + (f"; missing: {', '.join(cov.get('missing'))}" if cov.get("missing") else ""))
        rows = []
        for r in cov.get("roles", []):
            for m in r.get("movements", []):
                rows.append([r.get("role"), m.get("id"), m.get("count"), m.get("mean_gap")])
        print_table(["block_a_role", "movement", "count", "mean_gap"], rows)


def main():
    edge = find_edge()
    if not edge:
        print("Edge not found. Set EDGE_PATH to msedge.exe.", file=sys.stderr)
        return 3

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(APP_DIR)))
    server.done = threading.Event()
    server.results = None
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    profile_dir = tempfile.mkdtemp(prefix="engine-tests-edge-")
    url = f"http://127.0.0.1:{port}/tests/index.html"
    args = [
        edge,
        "--headless=new",
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-sync",
        "--disable-background-networking",
        "--disable-component-update",
        url,
    ]
    proc = None
    started = time.time()
    try:
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        got = server.done.wait(TIMEOUT_SEC)
    finally:
        leftover = kill_edge(proc, profile_dir)
        server.shutdown()
        server.server_close()
        removed = remove_profile(profile_dir)
    elapsed = time.time() - started

    if leftover:
        print(f"warning: Edge processes still running after cleanup: {leftover}", file=sys.stderr)
    if not removed:
        print(f"warning: could not remove temporary profile {profile_dir}", file=sys.stderr)

    if not got or server.results is None:
        print(f"TIMEOUT: no results from {url} within {TIMEOUT_SEC} seconds. "
              "Open the page in a browser to see what failed.", file=sys.stderr)
        return 2

    data = server.results
    results = data.get("results") or []
    for r in results:
        ok = bool(r.get("ok"))
        line = ("PASS  " if ok else "FAIL  ") + str(r.get("name"))
        if not ok and r.get("message"):
            line += "  -- " + str(r.get("message"))
        print(line)
    print_reports(data.get("reports") or {})
    passed = sum(1 for r in results if r.get("ok"))
    failed = len(results) - passed
    if not results:
        failed = max(1, int(data.get("failed") or 0))
    print()
    print(f"elapsed: {elapsed:.1f} s")
    print(f"TOTAL: {passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
