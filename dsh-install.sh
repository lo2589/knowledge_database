#!/usr/bin/env bash
# Put the known_manage plugin into a dsh profile (default: web), or take it out.
#
#   ./dsh-install.sh            install (safe to run again)
#   ./dsh-install.sh remove     uninstall
#   DSH_PROFILE=web ./dsh-install.sh
#
# What it does: links dsh-plugin-known-manage into the profile's node_modules
# and lists it in the profile package.json (dependencies + dsh.profile.bundles),
# the same way dsh-plugin-vco-debug is installed. package.json is backed up
# first. Restart dsh afterwards so it picks up the new bundle.
set -euo pipefail
cd "$(dirname "$0")"

PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/${DSH_PROFILE:-web}"
PLUGIN="$(pwd)/dsh-plugin-known-manage"
NAME=dsh-plugin-known-manage
PKG="$PROFILE_DIR/package.json"

[ -f "$PKG" ] || { echo "找不到 dsh profile：${PKG}"; exit 1; }
cp "$PKG" "$PKG.bak.$(date +%Y%m%d-%H%M%S)"

python3 - "$PKG" "$NAME" "$PLUGIN" "${1:-install}" <<'EOF'
import json, sys
pkg, name, path, mode = sys.argv[1:]
d = json.load(open(pkg))
deps = d.setdefault("dependencies", {})
bundles = d.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
if mode == "remove":
    deps.pop(name, None)
    if name in bundles:
        bundles.remove(name)
else:
    deps[name] = "link:" + path
    if name not in bundles:
        bundles.append(name)
json.dump(d, open(pkg, "w"), indent=2, ensure_ascii=False)
open(pkg, "a").write("\n")
EOF

if [ "${1:-install}" = "remove" ]; then
  rm -f "$PROFILE_DIR/node_modules/$NAME"
  echo "已从 ${PROFILE_DIR} 移除。重启 dsh 生效。"
else
  mkdir -p "$PROFILE_DIR/node_modules"
  ln -sfn "$PLUGIN" "$PROFILE_DIR/node_modules/$NAME"
  [ -x .venv/bin/python ] || echo "注意：还没装环境，先跑 ./setup.sh（插件要用 .venv 里的 Python 起知识库）"
  echo "已装进 ${PROFILE_DIR}。重启 dsh 后：左下角「知识库」、每条回答下「⊕ 入库」、会话顶部「⊕ 整段入库」。"
fi
