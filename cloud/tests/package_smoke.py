"""Verify archive/install/upgrade behavior, then smoke-test the installed local binary."""
import hashlib
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

archive = Path(sys.argv[1]).resolve()
root = Path(__file__).resolve().parents[2]
(root / ".dev").mkdir(exist_ok=True)
checksums = dict(line.split(None, 1)[::-1] for line in (archive.parent / "SHA256SUMS").read_text().splitlines())
assert hashlib.sha256(archive.read_bytes()).hexdigest() == checksums[archive.name]
with tempfile.TemporaryDirectory(prefix="install smoke ", dir=root / ".dev") as temporary:
    stage = Path(temporary)
    with tarfile.open(archive) as tar:
        tar.extractall(stage, filter="data")
    package = stage / archive.name.removesuffix(".tar.gz")
    prefix = stage / "isolated install"
    (prefix / "bin").mkdir(parents=True)
    legacy = prefix / "bin/autopilot"
    legacy.write_text("legacy sentinel")
    installed = prefix / "bin/autopilot-cloud"
    command = [str(package / "install.sh"), "--prefix", str(prefix)]
    subprocess.run(command, cwd=stage, check=True)
    original = installed.read_bytes()
    subprocess.run(command, cwd=stage, check=True)
    assert installed.read_bytes() == original and legacy.read_text() == "legacy sentinel"
    subprocess.run([sys.executable, str(root / "cloud/tests/local_smoke.py"), str(installed)], check=True)
    with (package / "bin/autopilot-cloud").open("ab") as file:
        file.write(b"corruption")
    corrupt = subprocess.run(command, capture_output=True, text=True)
    assert corrupt.returncode != 0
    assert installed.read_bytes() == original and legacy.read_text() == "legacy sentinel"
    print("PASS: archive checksum, isolated prefix with spaces, install/upgrade, legacy command retained, corrupt upgrade rejected")
