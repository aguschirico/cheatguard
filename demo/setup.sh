#!/usr/bin/env bash
# Builds the throwaway repositories the demo tapes record. Safe to re-run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/demo/.work"
DEPS="$ROOT/bench/.work/deps/node_modules"
rm -rf "$WORK" && mkdir -p "$WORK/bin"

cat > "$WORK/bin/cheatguard" <<SH
#!/usr/bin/env bash
exec node "$ROOT/packages/cli/dist/bin.js" "\$@"
SH
chmod +x "$WORK/bin/cheatguard"

init_repo() {
  git -C "$1" init -q -b main
  git -C "$1" config user.email demo@example.com
  git -C "$1" config user.name demo
  git -C "$1" add -A
  git -C "$1" commit -qm "baseline"
}

# 1) An agent "fixed" failing tests the wrong way.
cp -R "$ROOT/demo/fixtures/shop" "$WORK/shop"
init_repo "$WORK/shop"
cp -R "$ROOT/demo/fixtures/shop-cheat/." "$WORK/shop/"

# 2) A legacy codebase full of pre-existing warnings, plus one new mistake.
cp -R "$ROOT/demo/fixtures/legacy" "$WORK/legacy"
rm "$WORK/legacy/src/invoice.new.ts"
ln -s "$DEPS" "$WORK/legacy/node_modules"
printf 'node_modules\n' > "$WORK/legacy/.gitignore"
init_repo "$WORK/legacy"
cp "$ROOT/demo/fixtures/legacy/src/invoice.new.ts" "$WORK/legacy/src/invoice.ts"
echo "demo repositories ready in $WORK"
