#!/usr/bin/env python3
"""Fetch PDF from shitjournal.org preprints."""

import sys
import re
import time
import urllib.request
import json
from pathlib import Path

SUPABASE_URL = "https://bcgdqepzakcufaadgnda.supabase.co"
API_KEY = "sb_publishable_wHqWLjQwO2lMwkGLeBktng_Mk_xf5xd"
HEADERS = {
    "apikey": API_KEY,
    "Content-Type": "application/json",
}

DIM = "\033[2m"
BOLD = "\033[1m"
GREEN = "\033[32m"
CYAN = "\033[36m"
YELLOW = "\033[33m"
RED = "\033[31m"
RESET = "\033[0m"
CHECK = f"{GREEN}\u2713{RESET}"
CROSS = f"{RED}\u2717{RESET}"
ARROW = f"{CYAN}\u25b6{RESET}"


def log_step(msg: str):
    print(f"\n  {ARROW} {BOLD}{msg}{RESET}")


def log_detail(key: str, value: str):
    print(f"    {DIM}{key}:{RESET} {value}")


def log_ok(msg: str):
    print(f"    {CHECK} {msg}")


def log_fail(msg: str):
    print(f"    {CROSS} {RED}{msg}{RESET}")
    sys.exit(1)


def timed_request(label: str, req: urllib.request.Request) -> bytes:
    t0 = time.perf_counter()
    with urllib.request.urlopen(req) as resp:
        status = resp.status
        body = resp.read()
    elapsed = (time.perf_counter() - t0) * 1000
    log_detail("status", f"{status}")
    log_detail("time", f"{elapsed:.0f}ms")
    log_detail("size", f"{len(body):,} bytes")
    return body


def banner():
    print(f"""
{DIM}{'=' * 56}{RESET}
  {BOLD}S.H.I.T Journal  PDF Fetcher{RESET}
  {DIM}Supabase Storage > Signed URL > Download{RESET}
{DIM}{'=' * 56}{RESET}""")


def extract_id(input_str: str) -> str:
    log_step("Parsing input")
    log_detail("input", input_str)
    match = re.search(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        input_str,
    )
    if not match:
        log_fail(f"Cannot extract UUID from input")
    preprint_id = match.group(0)
    log_ok(f"Preprint ID: {CYAN}{preprint_id}{RESET}")
    return preprint_id


def get_pdf_path(preprint_id: str) -> tuple[str, str]:
    log_step("Querying preprint metadata")
    url = (
        f"{SUPABASE_URL}/rest/v1/preprints_with_ratings_mat"
        f"?select=id,pdf_path,manuscript_title,author_name,institution,created_at"
        f"&id=eq.{preprint_id}"
    )
    log_detail("endpoint", "preprints_with_ratings_mat")
    log_detail("url", f"{DIM}{url[:80]}...{RESET}")

    req = urllib.request.Request(url, headers=HEADERS)
    body = timed_request("metadata", req)
    data = json.loads(body)

    if not data:
        log_fail(f"Preprint not found")

    r = data[0]
    log_ok("Record found")
    log_detail("title", f"{YELLOW}{r.get('manuscript_title', '?')}{RESET}")
    log_detail("author", r.get("author_name", "?"))
    log_detail("institution", r.get("institution", "?"))
    log_detail("created", r.get("created_at", "?"))

    pdf_path = r.get("pdf_path")
    if not pdf_path:
        log_fail("No pdf_path in record")

    log_detail("pdf_path", f"{CYAN}{pdf_path}{RESET}")
    return pdf_path, r.get("manuscript_title", "unknown")


def get_signed_url(pdf_path: str) -> str:
    log_step("Requesting signed URL")
    url = f"{SUPABASE_URL}/storage/v1/object/sign/manuscripts/{pdf_path}"
    log_detail("bucket", "manuscripts")
    log_detail("expires", "3600s")
    log_detail("url", f"{DIM}{url[:80]}...{RESET}")

    body = json.dumps({"expiresIn": 3600}).encode()
    req = urllib.request.Request(url, data=body, headers=HEADERS, method="POST")
    resp_body = timed_request("sign", req)
    data = json.loads(resp_body)

    signed = data.get("signedURL")
    if not signed:
        log_fail("Signed URL not returned")

    full_url = f"{SUPABASE_URL}/storage/v1{signed}"
    token = signed.split("token=")[-1][:32] + "..."
    log_ok("Signed URL acquired")
    log_detail("token", f"{DIM}{token}{RESET}")
    return full_url


def download_pdf(signed_url: str, output: Path):
    log_step("Downloading PDF")
    log_detail("target", str(output))

    t0 = time.perf_counter()
    req = urllib.request.Request(signed_url)

    with urllib.request.urlopen(req) as resp:
        total = int(resp.headers.get("Content-Length", 0))
        downloaded = 0
        chunk_size = 8192

        with open(output, "wb") as f:
            while True:
                chunk = resp.read(chunk_size)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)

                if total > 0:
                    pct = downloaded / total
                    bar_len = 30
                    filled = int(bar_len * pct)
                    bar = f"{'█' * filled}{'░' * (bar_len - filled)}"
                    sys.stdout.write(
                        f"\r    {DIM}progress:{RESET} {bar} {pct * 100:5.1f}%  "
                        f"{downloaded / 1024:.0f}/{total / 1024:.0f} KB"
                    )
                    sys.stdout.flush()

    elapsed = (time.perf_counter() - t0) * 1000
    print()
    size = output.stat().st_size
    log_ok("Download complete")
    log_detail("file", str(output.resolve()))
    log_detail("size", f"{size:,} bytes ({size / 1024 / 1024:.2f} MB)")
    log_detail("time", f"{elapsed:.0f}ms")
    if elapsed > 0:
        speed = size / 1024 / (elapsed / 1000)
        log_detail("speed", f"{speed:.0f} KB/s")


def main():
    if len(sys.argv) < 2:
        print(f"Usage: python fetch_pdf.py <preprint_id_or_url> [output.pdf]")
        sys.exit(1)

    banner()

    t_start = time.perf_counter()

    preprint_id = extract_id(sys.argv[1])
    pdf_path, title = get_pdf_path(preprint_id)
    signed_url = get_signed_url(pdf_path)

    if len(sys.argv) >= 3:
        output = Path(sys.argv[2])
    else:
        output = Path(pdf_path.split("/")[-1])

    download_pdf(signed_url, output)

    total_time = (time.perf_counter() - t_start) * 1000
    print(f"\n{DIM}{'─' * 56}{RESET}")
    print(f"  {CHECK} {BOLD}All done{RESET} in {total_time:.0f}ms")
    print(f"{DIM}{'─' * 56}{RESET}\n")


if __name__ == "__main__":
    main()
