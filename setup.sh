#!/usr/bin/env bash
# Build the virtualenv: FastNode (from the sibling Node checkout) + PDF/Word readers.
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3.11}"
NODE_DIR="${FASTNODE_DIR:-../Node}"

"$PY" -c 'import sys; assert sys.version_info[:2] == (3, 11), "需要 Python 3.11"'

[ -d .venv ] || "$PY" -m venv .venv

wheel=$(ls "$NODE_DIR"/target/wheels/fastnode-*-cp311-*.whl 2>/dev/null | tail -1 || true)
if [ -z "$wheel" ]; then
  echo "没找到 FastNode 的 wheel，从 $NODE_DIR 现编一个（要 Rust 工具链）…"
  .venv/bin/pip install -q maturin
  (cd "$NODE_DIR" && "$OLDPWD/.venv/bin/maturin" build --release)
  wheel=$(ls "$NODE_DIR"/target/wheels/fastnode-*-cp311-*.whl | tail -1)
fi

.venv/bin/pip install -q --force-reinstall "$wheel"
.venv/bin/pip install -q pypdf python-docx
mkdir -p data
echo "好了。启动：.venv/bin/python -m km --open"
