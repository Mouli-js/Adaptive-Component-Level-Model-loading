#!/usr/bin/env bash
# Build → Word fields → render → page numbers, twice, then confirm the page numbers are stable.
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_PATH="${NODE_PATH:-$(npm root -g)}"
for pass in 1 2 3; do
  (cd src && node build.js pages.json >/dev/null)
  python3 tools/finalize.py
  cp src/pages.json build/pages.prev.json 2>/dev/null || true
  python3 tools/paginate.py
  if cmp -s <(python3 -m json.tool --sort-keys build/pages.prev.json) <(python3 -m json.tool --sort-keys src/pages.json); then echo "page numbers stable after pass $pass"; exit 0; fi
done
echo "page numbers NOT stable"; exit 1
