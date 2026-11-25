"""Download the pinned 5B subset with resumable parallel ranges and LFS checks."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from itertools import zip_longest
from pathlib import Path
import hashlib
import json
import os
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

REVISION = "4efc2c4c33af7863f6048e36c2bceb2c30bfae97"
REPO = "VAST-AI/EdenLive"
ROOT = f"https://huggingface.co/{REPO}/resolve/{REVISION}"
PREFIXES = ("dit-5b/", "vae-5b/", "decoder-5b/", "umt5/", "vision-encoder/", "scheduler-5b/", "LICENSE")
BLOCK = 32 * 1024 * 1024


def request(url, headers=None, method=None):
    return urlopen(Request(url, headers=headers or {}, method=method), timeout=45)


class RangedFile:
    def __init__(self, root, entry, endpoint):
        self.url = f"{endpoint}/{REPO}/resolve/{REVISION}/{quote(entry['path'])}?download=true"
        self.resolve_ranges = endpoint != "https://huggingface.co"
        self.path = root / entry["path"]
        self.partial = self.path.with_name(self.path.name + ".partial")
        self.state = self.path.with_name(self.path.name + ".ranges")
        self.stamp = self.path.with_name(self.path.name + ".verified")
        self.size = entry["size"]
        self.sha256 = entry["lfs"]["oid"]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.redirect = None

    def setup(self):
        if self.path.is_file() and self.path.stat().st_size == self.size:
            expected = f"{self.sha256} {self.path.stat().st_mtime_ns}\n"
            if self.stamp.is_file() and self.stamp.read_text() == expected:
                return []
            if self.digest(self.path) == self.sha256:
                self.stamp.write_text(expected)
                return []
        if not self.partial.is_file() or self.partial.stat().st_size != self.size:
            self.state.unlink(missing_ok=True)
        self.fd = os.open(self.partial, os.O_CREAT | os.O_RDWR, 0o644)
        os.ftruncate(self.fd, self.size)
        completed = set(self.state.read_text().splitlines()) if self.state.is_file() else set()
        return list(start for start in range(0, self.size, BLOCK) if str(start) not in completed)

    def target(self, renew=False):
        if self.resolve_ranges:
            return self.url
        with self.lock:
            if self.redirect is None or renew:
                with request(self.url, method="HEAD") as response:
                    self.redirect = response.url
            return self.redirect

    def fetch(self, start):
        stop = min(start + BLOCK, self.size) - 1
        offset = start
        for attempt in range(6):
            try:
                with request(self.target(), {"Range": f"bytes={offset}-{stop}"}) as response:
                    content = response.headers.get("Content-Range")
                    if response.status != 206 or content != f"bytes {offset}-{stop}/{self.size}":
                        raise ValueError(f"Range {offset}-{stop} rejected for {self.path.name}: {content}")
                    while offset <= stop:
                        data = response.read(min(1024 * 1024, stop + 1 - offset))
                        if not data:
                            raise IOError("short response")
                        written = os.pwrite(self.fd, data, offset)
                        if not written:
                            raise IOError("short disk write")
                        offset += written
                        if written != len(data):
                            raise IOError("partial disk write")
                with self.lock, self.state.open("a") as state:
                    state.write(f"{start}\n")
                return
            except (HTTPError, URLError, OSError) as error:
                if attempt == 5:
                    raise
                if isinstance(error, HTTPError) and error.code in (401, 403):
                    self.target(renew=True)
                time.sleep(1 + attempt * 2)

    def finish(self):
        if not hasattr(self, "fd"):
            return
        os.fsync(self.fd)
        os.close(self.fd)
        if self.digest(self.partial) != self.sha256:
            self.state.unlink(missing_ok=True)
            raise ValueError(f"SHA256 mismatch for {self.path}")
        self.partial.replace(self.path)
        self.stamp.write_text(f"{self.sha256} {self.path.stat().st_mtime_ns}\n")
        self.state.unlink(missing_ok=True)
        print(f"Verified {self.path.name} ({self.size:,} bytes)", flush=True)

    @staticmethod
    def digest(path):
        with path.open("rb") as file:
            return hashlib.file_digest(file, "sha256").hexdigest()


def small_file(root, entry):
    path = root / entry["path"]
    def correct(data):
        if len(data) != entry["size"]:
            return False
        blob = f"blob {len(data)}\0".encode() + data
        return hashlib.sha1(blob).hexdigest() == entry["oid"]

    if path.is_file() and correct(path.read_bytes()):
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with request(f"{ROOT}/{quote(entry['path'])}") as response:
        data = response.read()
    if not correct(data):
        raise ValueError(f"Git blob hash mismatch for {path}")
    path.write_bytes(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--jobs", type=int, default=48)
    parser.add_argument("--mirror", default="https://huggingface.co",
                        help="Use a mirror for data only; verify against the official revision manifest")
    parser.add_argument("--bidirectional-only", action="store_true",
                        help="Fetch the additional 5B bidirectional DiT for offline quality evaluation")
    args = parser.parse_args()
    if not args.mirror.startswith("https://"):
        parser.error("--mirror requires HTTPS")
    args.root.mkdir(parents=True, exist_ok=True)
    manifest = args.root / f".manifest-{REVISION}.json"
    if manifest.is_file():
        entries = json.loads(manifest.read_text())
    else:
        url = f"https://huggingface.co/api/models/{REPO}/tree/{REVISION}?recursive=true"
        for attempt in range(4):
            try:
                with request(url) as response:
                    entries = json.load(response)
                break
            except (HTTPError, URLError, OSError):
                if attempt == 3:
                    raise
                time.sleep(2**attempt)
        manifest.write_text(json.dumps(entries))
    prefixes = ("dit-5b-bidir/",) if args.bidirectional_only else PREFIXES
    selected = [e for e in entries if e["type"] == "file" and e["path"].startswith(prefixes)]
    ranged = [RangedFile(args.root, e, args.mirror.rstrip("/")) for e in selected if "lfs" in e]
    schedules = [[(file, start) for start in file.setup()] for file in ranged]
    remaining = dict(zip(ranged, map(len, schedules)))
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        small = [pool.submit(small_file, args.root, entry) for entry in selected if "lfs" not in entry]
        # Round robin the large components to use the available connections.
        chunks = {pool.submit(file.fetch, start): file for row in zip_longest(*schedules)
                  for file, start in filter(None, row)}
        finished = [pool.submit(file.finish) for file in ranged if not remaining[file]]
        started = time.monotonic()
        for index, job in enumerate(as_completed(chunks), 1):
            job.result()
            file = chunks[job]
            remaining[file] -= 1
            if not remaining[file]:
                finished.append(pool.submit(file.finish))
            if index == 1 or index % 20 == 0 or index == len(chunks):
                print(f"Ranges {index}/{len(chunks)} in {time.monotonic()-started:.1f}s", flush=True)
        for job in small + finished:
            job.result()


if __name__ == "__main__":
    main()
