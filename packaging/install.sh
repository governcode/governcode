#!/bin/sh
# Installs this GovernCode release for the current user. Nothing needs root.
#   ./install.sh             install to ~/.local/share/governcode/VERSION, link gov, govd and
#                            governcode-dashboard into ~/.local/bin, run the sandbox self-test
#   ./install.sh --service   also add a systemd user service that starts govd at login
set -eu
here=$(cd "$(dirname "$0")" && pwd)
ver=$(cat "$here/VERSION")
dest="${GOVERNCODE_HOME:-$HOME/.local/share/governcode}/$ver"
bindir="${GOVERNCODE_BIN:-$HOME/.local/bin}"

command -v node >/dev/null 2>&1 || { echo "GovernCode needs Node.js 22.18 or newer (not found)."; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || { echo "GovernCode needs Node.js 22.18 or newer (found $(node --version))."; exit 1; }

if [ "$here" != "$dest" ]; then
  mkdir -p "$dest"
  cp -a "$here/." "$dest/"
fi
mkdir -p "$bindir"
for b in gov govd governcode-dashboard; do ln -sf "$dest/bin/$b" "$bindir/$b"; done
echo "Installed GovernCode $ver in $dest"
echo "Linked gov, govd and governcode-dashboard into $bindir"

echo
echo "Sandbox self-test (GovernCode starts no AI tool unless this passes):"
if "$dest/target/release/govern-sup" selftest; then
  ok=1
else
  ok=0
  echo
  echo "The self-test did not pass on this machine, so GovernCode will refuse to start AI tools."
  echo "That is on purpose: it fails closed. docs/SANDBOX.md says what each rule needs."
fi

if [ "${1:-}" = "--service" ]; then
  unit="$HOME/.config/systemd/user/governcode.service"
  mkdir -p "$(dirname "$unit")"
  cat > "$unit" <<UNIT
[Unit]
Description=GovernCode daemon (govd)

[Service]
ExecStart=$bindir/govd
Restart=on-failure

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload && systemctl --user enable --now governcode.service
  echo "govd runs as the systemd user service governcode.service"
fi

echo
echo "Next:"
[ "${1:-}" = "--service" ] || echo "  govd &                 # start the daemon (or re-run with --service)"
echo "  gov demo               # a real task in about five minutes"
echo "  governcode-dashboard   # the desktop app"
case ":$PATH:" in *":$bindir:"*) ;; *) echo; echo "Add $bindir to your PATH to use these commands.";; esac
[ "$ok" = 1 ]
