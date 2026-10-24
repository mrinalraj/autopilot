"""Exercise a built image using disposable storage and fake agents only.

Run: python3 tests/docker_smoke.py [image]
No API credentials, hosting accounts, or real harness processes are used.
"""
import hashlib
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

image = sys.argv[1] if len(sys.argv) > 1 else "autopilot-cloud:0.1.0"
name = "autopilot-smoke-" + uuid.uuid4().hex[:10]
volume = name + "-data"
csrf = ""
base = ""


def docker(*args, input=None):
    return subprocess.check_output(["docker", *args], input=input, text=True).strip()


def inside(*args, input=None):
    return docker("exec", "-i", name, *args, input=input)


def api(path, body=None, key=None):
    headers = {"Host": "127.0.0.1:4780", "X-CSRF-Token": csrf}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if key:
        headers["Idempotency-Key"] = key
    request = urllib.request.Request(base + "/api/v1" + path,
        data=json.dumps(body).encode() if body is not None else None, headers=headers)
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def wait_for(fn, timeout=30):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        try:
            result = fn()
            if result:
                return result
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(0.25)
    raise AssertionError("Timed out waiting for " + fn.__name__)


try:
    docker("volume", "create", volume)
    docker("run", "-d", "--name", name, "-p", "127.0.0.1::4780",
           "-v", volume + ":/data", image)
    base = "http://" + docker("port", name, "4780/tcp").splitlines()[0]
    snap = wait_for(lambda: api("/snapshot"))
    csrf = snap["csrf"]
    assert inside("id", "-u") == "10001", "image must run without root"
    profiles = [{"id": harness, "label": harness, "command": "/bin/sh",
                 "args": ["/data/fake-agent.sh"], "promptMode": "arg",
                 "resumeArgs": ["/data/fake-agent.sh", "--resume", "{conversation}"]}
                for harness in ["fake-one", "fake-two"]]
    inside("sh", "-c", "cat > /data/settings.json", input=json.dumps({"profiles": profiles}))
    inside("sh", "-c", "cat > /data/fake-agent.sh", input='''#!/bin/sh
echo "FAKE AGENT $*"
autopilot report --state idle --conversation "conversation-$AUTOPILOT_SESSION_ID" --message ready
while IFS= read -r line; do printf 'RECEIVED %s\n' "$line"; done
''')
    docker("restart", name)
    base = "http://" + docker("port", name, "4780/tcp").splitlines()[0]
    wait_for(lambda: api("/snapshot"))
    inside("mkdir", "-p", "/data/workspaces/smoke/repo")
    inside("git", "init", "-b", "main", "/data/workspaces/smoke/repo")
    inside("git", "-C", "/data/workspaces/smoke/repo", "-c", "user.name=Smoke",
           "-c", "user.email=smoke@example.test", "commit", "--allow-empty", "-m", "initial")
    workspace = api("/workspaces", {"name": "Smoke", "root": "/data/workspaces/smoke"})
    repo = api("/repositories", {"workspaceId": workspace["id"], "path": "/data/workspaces/smoke/repo"})
    tasks = []
    for index, harness in enumerate(["fake-one", "fake-two"]):
        issue = api("/issues", {"workspaceId": workspace["id"], "title": "Worker " + str(index)})
        tasks.append({"id": "task-" + str(index), "issueId": issue["id"], "title": issue["title"],
                      "prompt": "Exercise persistence", "repositoryIds": [repo["id"]],
                      "dependsOn": [], "harness": harness})
    plan = api("/plans", {"workspaceId": workspace["id"], "title": "Smoke plan", "tasks": tasks})
    execution = api("/plans/" + plan["id"] + "/approve", {"revision": plan["revision"]}, "smoke-approve")
    duplicate = api("/plans/" + plan["id"] + "/approve", {"revision": plan["revision"]}, "smoke-approve")
    assert duplicate["id"] == execution["id"]

    def workers_ready():
        snapshot = api("/snapshot")
        return snapshot if len(snapshot["sessions"]) == 2 and all(s["conversationId"] for s in snapshot["sessions"]) else None

    before = wait_for(workers_ready)
    assert {s["harness"]["id"] for s in before["sessions"]} == {"fake-one", "fake-two"}
    socket = "/tmp/autopilot-" + hashlib.sha256(b"/data").hexdigest()[:16] + ".sock"
    pids = inside("tmux", "-S", socket, "list-panes", "-a", "-F", "#{pane_pid}")
    server_pid = inside("node", "-e", r'''const fs=require('fs');for(const p of fs.readdirSync('/proc')){if(!/^\d+$/.test(p))continue;try{const a=fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\0');if(a[0].endsWith('/autopilot')&&a[1]==='serve')console.log(p)}catch{}}''')
    assert server_pid.isdigit(), "could not identify only the API process"
    inside("sh", "-c", 'kill -KILL "$1"', "sh", server_pid)
    time.sleep(1.5)
    adopted = wait_for(workers_ready)
    assert [s["generation"] for s in adopted["sessions"]] == [s["generation"] for s in before["sessions"]]
    assert inside("tmux", "-S", socket, "list-panes", "-a", "-F", "#{pane_pid}") == pids
    print("PASS: non-root image, two harnesses, idempotent approval, API crash adoption")

    docker("restart", name)
    base = "http://" + docker("port", name, "4780/tcp").splitlines()[0]

    def resumed():
        snapshot = workers_ready()
        return snapshot if snapshot and all(new["generation"] != old["generation"] for new, old in zip(snapshot["sessions"], before["sessions"])) else None

    after = wait_for(resumed)
    assert [s["id"] for s in after["sessions"]] == [s["id"] for s in before["sessions"]]
    assert [s["conversationId"] for s in after["sessions"]] == [s["conversationId"] for s in before["sessions"]]
    for session in after["sessions"]:
        api("/sessions/" + session["id"] + "/send", {"body": "after restart"})
        wait_for(lambda: "RECEIVED after restart" in api("/sessions/" + session["id"] + "/preview")["preview"])
    inside("autopilot", "backup", "/data/smoke-snapshot.sqlite")
    assert int(inside("stat", "-c", "%s", "/data/smoke-snapshot.sqlite")) > 0
    for run in after["runs"]:
        api("/runs/" + run["id"] + "/complete", {})
    final = api("/snapshot")
    assert all(r["state"] == "completed" for r in final["runs"])
    assert all(i["status"] == "done" for i in final["issues"])
    assert final["executions"][0]["state"] == "completed"
    print("PASS: container restart, exact conversation recovery, input, backup, manual acceptance")
except Exception:
    print(docker("logs", "--tail", "30", name), flush=True)
    raise
finally:
    subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["docker", "volume", "rm", volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
