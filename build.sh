#!/usr/bin/env bash
# Package src/ into dist/rethread-<version>.xpi
set -euo pipefail
cd "$(dirname "$0")"
version=$(python3 -c 'import json; print(json.load(open("src/manifest.json"))["version"])')
mkdir -p dist
rm -f "dist/rethread-$version.xpi"
(cd src && zip -qrX "../dist/rethread-$version.xpi" manifest.json background.js rethread-core.js icon.svg)
echo "dist/rethread-$version.xpi"
