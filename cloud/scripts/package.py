#!/usr/bin/env python3
"""Build relocatable archives with deterministic metadata; never install or publish."""
import argparse
import gzip
import hashlib
import io
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

root = Path(__file__).resolve().parents[1]
supported = ("darwin/arm64", "darwin/amd64", "linux/arm64", "linux/amd64")
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--targets", nargs="+", choices=supported, default=list(supported))
parser.add_argument("--output", type=Path, default=root / "dist")
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=True)
revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
if subprocess.check_output(["git", "status", "--porcelain"], cwd=root).strip():
    revision += "-dirty"
subprocess.run(["bun", "install", "--frozen-lockfile"], cwd=root / "web", check=True)
subprocess.run(["bun", "run", "build"], cwd=root / "web", check=True)
checksums = []
with tempfile.TemporaryDirectory(prefix="package-", dir=out) as temporary:
    stage = Path(temporary)
    for target in args.targets:
        goos, arch = target.split("/")
        name = f"autopilot-cloud-{goos}-{arch}"
        package = stage / name
        (package / "bin").mkdir(parents=True)
        env = dict(os.environ, CGO_ENABLED="0", GOOS=goos, GOARCH=arch)
        subprocess.run(["go", "build", "-mod=readonly", "-tags", "webassets", "-trimpath", "-buildvcs=false",
                        f"-ldflags=-s -w -X main.revision={revision}", "-o", str(package / "bin/autopilot-cloud"),
                        "./cmd/autopilot"], cwd=root, env=env, check=True)
        for source, dest in [(root / "scripts/install.sh", "install.sh"),
                             (root.parent / "docs/local-install.md", "README.md"),
                             (root.parent / "LICENSE", "LICENSE")]:
            shutil.copyfile(source, package / dest)
        (package / "BUILD.txt").write_text(f"revision={revision}\ntarget={target}\n" +
            subprocess.check_output(["go", "version"], text=True) + "bun=" +
            subprocess.check_output(["bun", "--version"], text=True))
        # The installer verifies the executable even when run from an extracted archive.
        digest = hashlib.sha256((package / "bin/autopilot-cloud").read_bytes()).hexdigest()
        (package / "SHA256SUMS").write_text(f"{digest}  bin/autopilot-cloud\n")
        archive = out / (name + ".tar.gz")
        with archive.open("wb") as output, gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode="w", format=tarfile.USTAR_FORMAT) as tar:
                for file in sorted(package.rglob("*")):
                    if not file.is_file():
                        continue
                    data = file.read_bytes()
                    info = tarfile.TarInfo(str(file.relative_to(stage)))
                    info.size, info.mtime = len(data), 0
                    info.mode = 0o755 if file.name in ("autopilot-cloud", "install.sh") else 0o644
                    tar.addfile(info, io.BytesIO(data))
        checksums.append(f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n")
        print(f"Built {archive.name} ({revision})", flush=True)
(out / "SHA256SUMS").write_text("".join(checksums))
