#!/usr/bin/env python3
"""Build dist/graphite-sider-<version>.xpi from the extension/ directory.

Validates that extension/manifest.json parses and that the files the
extension needs at load time exist, then zips the whole extension/
directory (excluding only .DS_Store files). Prints the SHA-256 and size
of the produced .xpi.
"""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
DIST = ROOT / "dist"

REQUIRED_FILES = [
    "manifest.json",
    "options/options.html",
    "options/options.css",
    "options/options.js",
]

# Optional integration points owned by other parts of the project. They are
# reported as warnings (not hard failures) so the options/build tooling can
# be built and tested before the core extension lands.
OPTIONAL_FILES = [
    "lib/storage.js",
    "lib/prompts.js",
    "lib/providers.js",
]


def fail(msg):
    print(f"error: {msg}", file=sys.stderr)
    return 1


def main():
    manifest_path = EXT / "manifest.json"
    if not manifest_path.is_file():
        return fail(f"manifest not found: {manifest_path} (core extension not present yet?)")

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - report any parse failure
        return fail(f"manifest.json does not parse: {exc}")

    version = str(manifest.get("version") or "").strip()
    if not version:
        return fail("manifest.json has no version")

    for rel in REQUIRED_FILES:
        if not (EXT / rel).is_file():
            return fail(f"required file missing: extension/{rel}")

    for rel in OPTIONAL_FILES:
        if not (EXT / rel).is_file():
            print(f"warning: optional file not present yet: extension/{rel}")

    DIST.mkdir(parents=True, exist_ok=True)
    out = DIST / f"graphite-sider-{version}.xpi"

    files = sorted(
        p for p in EXT.rglob("*")
        if p.is_file() and p.name != ".DS_Store"
    )
    if not files:
        return fail("no files found under extension/")

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in files:
            zf.write(path, path.relative_to(EXT).as_posix())

    data = out.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    print(f"built: {out} ({len(files)} files)")
    print(f"version: {version}")
    print(f"size: {len(data)} bytes")
    print(f"sha256: {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
