#!/usr/bin/python3
"""FIFO diagnostic delay fixture; forwards the real server protocol unchanged."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

command = os.environ["MOGNITIO_PROXY_SERVER"]
gate = Path(os.environ["MOGNITIO_PROXY_GATE"])
if sys.argv[1:] == ["--version"]:
    raise SystemExit(subprocess.run([command, "--version"]).returncode)
child = subprocess.Popen([command, "--stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
def terminate(*_):
    child.kill()
    raise SystemExit(1)
signal.signal(signal.SIGTERM, terminate)
def forward_input():
    try:
        while data := os.read(0, 65536):
            child.stdin.write(data)
            child.stdin.flush()
    except (BrokenPipeError, OSError):
        pass
    finally:
        child.stdin.close()
threading.Thread(target=forward_input, daemon=True).start()
try:
    while True:
        headers = b""
        length = None
        while True:
            line = child.stdout.readline()
            if not line:
                raise SystemExit(child.wait())
            headers += line
            if line == b"\r\n":
                break
            key, value = line.split(b":", 1)
            if key.lower() == b"content-length":
                length = int(value)
        body = child.stdout.read(length)
        if (gate / "pause").exists():
            (gate / "paused").write_text("ready")
            deadline = time.monotonic() + 15
            while not (gate / "resume").exists():
                if time.monotonic() >= deadline:
                    raise RuntimeError("Manifest observation fixture timed out")
                time.sleep(0.01)
        message = json.loads(body)
        delayed = False
        arm = gate / "arm"
        if arm.exists() and message.get("method") == "textDocument/publishDiagnostics":
            params = message["params"]
            if params["uri"] == arm.read_text() and params["diagnostics"]:
                arm.unlink()
                (gate / "held").write_text(json.dumps(params))
                deadline = time.monotonic() + 15
                while not (gate / "release").exists():
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Diagnostic delay fixture timed out")
                    time.sleep(0.01)
                delayed = True
        sys.stdout.buffer.write(headers + body)
        sys.stdout.buffer.flush()
        if delayed:
            (gate / "released").write_text("ready")
            deadline = time.monotonic() + 15
            while not (gate / "continue").exists():
                if time.monotonic() >= deadline:
                    raise RuntimeError("Diagnostic observation fixture timed out")
                time.sleep(0.01)
finally:
    if child.poll() is None:
        child.kill()
    child.wait()
