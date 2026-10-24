"""Smoke-test a relocated packaged executable with disposable data and no real agents."""
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

binary = str(Path(sys.argv[1]).resolve())
root = Path(__file__).resolve().parents[2]
(root / ".dev").mkdir(exist_ok=True)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


with tempfile.TemporaryDirectory(prefix="local-smoke-", dir=root / ".dev") as directory:
    data = Path(directory) / "persistent data"
    data.mkdir()
    (data / "settings.json").write_text('{"maxWorkers":2}')
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    env = {k: v for k, v in os.environ.items() if not k.startswith("AUTOPILOT_")}
    env.update(AUTOPILOT_DATA_DIR=str(data), AUTOPILOT_LISTEN=f"127.0.0.1:{port}",
               AUTOPILOT_ALLOWED_HOSTS=f"127.0.0.1:{port}")
    process = None
    csrf = ""

    def get(path):
        return urllib.request.urlopen(base + path, timeout=3)

    def api(path, body=None):
        request = urllib.request.Request(base + "/api/v1" + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json", "X-CSRF-Token": csrf})
        with urllib.request.urlopen(request, timeout=3) as response:
            assert response.headers["Cache-Control"] == "no-store"
            return json.load(response)

    def start(command="start"):
        global process
        process = subprocess.Popen([binary, command], cwd=directory, env=env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for _ in range(100):
            if process.poll() is not None:
                raise AssertionError(process.communicate())
            try:
                with get("/healthz") as response:
                    assert json.load(response) == {"status": "ok"}
                    return
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                time.sleep(0.1)
        raise AssertionError("server did not become ready")

    def stop():
        global process
        process.terminate()
        _, log = process.communicate(timeout=10)
        assert process.returncode == 0, log
        assert "Autopilot ready" in log
        process = None

    def failure(expected, overrides=None):
        run = subprocess.run([binary, "start"], cwd=directory, env=dict(env, **(overrides or {})),
                             capture_output=True, text=True, timeout=10)
        assert run.returncode != 0 and expected in run.stderr, (expected, run.returncode, run.stderr)

    try:
        failure("git is required", {"PATH": str(Path(directory) / "no-tools")})
        (data / "settings.json").write_text("malformed")
        failure("read settings")
        (data / "settings.json").write_text('{"maxWorkers":2}')
        start()
        snapshot = api("/snapshot")
        csrf = snapshot["csrf"]
        settings = api("/settings")
        assert settings["executionEnvironment"] == "host" and settings["maxWorkers"] == 2
        with get("/") as response:
            html = response.read().decode()
            assert response.headers["Cache-Control"] == "no-cache"
            assert 'rel="manifest"' in html
        for asset in re.findall(r'(?:src|href)="([^"]+)"', html):
            if asset.startswith("/"):
                with get(asset) as response:
                    assert response.status == 200
                    assert not response.read().startswith(b"<!doctype")
        with get("/manifest.webmanifest") as response:
            assert response.headers["Content-Type"] == "application/manifest+json"
            manifest = json.load(response)
            assert manifest["display"] == "standalone" and manifest["id"] == "/"
        for icon in manifest["icons"]:
            with get(icon["src"]) as response:
                assert response.headers["Content-Type"] == "image/png"
                assert response.read().startswith(b"\x89PNG")
        with get("/service-worker.js") as response:
            assert "__OFFLINE_VERSION__" not in response.read().decode()
            assert response.headers["Cache-Control"] == "no-cache"
        try:
            get("/assets/absent.js")
            raise AssertionError("missing asset returned success")
        except urllib.error.HTTPError as error:
            assert error.code == 404
        workspace = api("/workspaces", {"name": "Persistent smoke workspace"})
        issue = api("/issues", {"workspaceId": workspace["id"], "title": "Persistent smoke issue"})
        failure("AUTOPILOT_LISTEN")
        other_port = free_port()
        failure("another server owns data directory", {"AUTOPILOT_LISTEN": f"127.0.0.1:{other_port}"})
        stop()
        start()
        after = api("/snapshot")
        assert after["csrf"] == csrf
        assert any(w["id"] == workspace["id"] for w in after["workspaces"])
        assert any(i["id"] == issue["id"] for i in after["issues"])
        assert api("/settings")["maxWorkers"] == 2
        assert not after["sessions"], "smoke test must never start a real harness"
        stop()
        start("serve")
        assert api("/settings")["executionEnvironment"] == "isolated"
        stop()
        print("PASS: relocated embedded UI, icons/manifest/worker, missing assets, startup errors, locking, workspace/issue/config persistence, local/serve defaults")
    finally:
        if process is not None:
            process.terminate()
            process.communicate(timeout=10)
