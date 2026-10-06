#!/bin/sh
# Installs this GovernCode release for the current user. Nothing needs root.
#   ./install.sh             install to ~/.local/share/governcode/VERSION, link gov, govd and
#                            governcode-dashboard into ~/.local/bin, run the sandbox self-test
#   ./install.sh --service   also add a systemd user service that starts govd at login
#   ./install.sh --uninstall [--purge]
#                            remove the service, the links, the launcher entry and every
#                            installed version; --purge also removes GovernCode's state (the
#                            Trace, settings, Specs) and the Dashboard's settings. Your
#                            projects are never touched.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
ver=$(cat "$here/VERSION")
root="${GOVERNCODE_HOME:-$HOME/.local/share/governcode}"
root=${root%/}
dest="$root/$ver"
bindir="${GOVERNCODE_BIN:-$HOME/.local/bin}"
config="${XDG_CONFIG_HOME:-$HOME/.config}"
unit="$config/systemd/user/governcode.service"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

if [ "${1:-}" = "--uninstall" ]; then
  # Removes only what it can show is GovernCode's: releases carrying the mark this script leaves
  # in each folder it installs, links and a launcher entry pointing exactly into those, a unit
  # that describes govd, and (with --purge) a state folder govd marked as its own. Everything is
  # checked before anything is removed.
  purge=0
  case "${2:-}" in --purge) purge=1 ;; "") ;; *) echo "Unknown option: $2"; exit 2 ;; esac
  rootc=$(cd "$root" 2>/dev/null && pwd -P) || rootc=$root
  # Paths are only ever taken straight from the glob, never stored in a list (a folder name
  # may hold a newline).
  owned() {   # is $1 exactly "<a marked release>/bin/<name>"?
    for d in "$root"/*/; do
      d=${d%/}
      if [ -f "$d/.installed-by-governcode" ] && [ "$1" = "$d/bin/$2" ]; then echo yes; return; fi
    done
  }
  service=0
  if [ -f "$unit" ]; then
    if grep -qxF "Description=GovernCode daemon (govd)" "$unit"; then
      loaded=$(systemctl --user show -P FragmentPath governcode.service 2>/dev/null || true)
      if [ -n "$loaded" ] && [ "$loaded" != "$unit" ]; then
        echo "The loaded governcode.service is $loaded, not $unit. Nothing was removed."; exit 1
      fi
      service=1
      cg=$(systemctl --user show -P ControlGroup governcode.service 2>/dev/null || true)
    else
      echo "Kept $unit: it is not GovernCode's unit"
    fi
  fi
  # Anything still running from the install, other than this script and the service's own
  # processes (stopping the service ends those): stop it first, nothing is deleted under it.
  # A process counts when its command line, working folder or executable is inside the install.
  # ponytail: a process started with a relative path from a folder outside the install is not
  # seen; the service and the launchers (which resolve their own paths) always are.
  running=""
  for p in /proc/[0-9]*; do
    pid=${p#/proc/}
    if [ "$pid" = "$$" ]; then continue; fi
    if [ "$service" = 1 ] && [ -n "${cg:-}" ] && { grep -qxF "0::$cg" "$p/cgroup" 2>/dev/null || grep -qF "0::$cg/" "$p/cgroup" 2>/dev/null; }; then continue; fi
    where="$(readlink "$p/cwd" 2>/dev/null || true)/ $(readlink "$p/exe" 2>/dev/null || true)"
    if grep -qaF -- "$root/" "$p/cmdline" 2>/dev/null || grep -qaF -- "$rootc/" "$p/cmdline" 2>/dev/null; then
      running="$running $pid"
    else
      case "$where" in "$root/"*|"$rootc/"*|*" $root/"*|*" $rootc/"*) running="$running $pid" ;; esac
    fi
  done
  if [ -n "$running" ]; then
    echo "GovernCode is still running from $root (process$running)."
    echo "Stop govd and the Dashboard, then run this again. Nothing was removed."
    exit 1
  fi
  if [ "$service" = 1 ]; then
    if ! systemctl --user disable --now governcode.service >/dev/null 2>&1; then
      echo "Could not stop governcode.service (systemctl --user disable --now governcode.service). Nothing was removed."; exit 1
    fi
    rm -f "$unit"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "Stopped and removed the governcode.service user service"
  fi
  for b in gov govd governcode-dashboard; do
    [ -L "$bindir/$b" ] || continue
    if [ "$(owned "$(readlink "$bindir/$b")" "$b")" = yes ]; then rm -f "$bindir/$b"; echo "Removed $bindir/$b"
    else echo "Kept $bindir/$b: it does not point into this install"; fi
  done
  entry="$apps/governcode-dashboard.desktop"
  if [ -f "$entry" ]; then
    exe=$(sed -n 's/^Exec=//p' "$entry" | head -n 1)
    if [ "$(owned "$exe" governcode-dashboard)" = yes ]; then rm -f "$entry"; echo "Removed the launcher entry"
    else echo "Kept $entry: it does not point into this install"; fi
  fi
  for d in "$root"/*/; do
    d=${d%/}
    if [ -f "$d/.installed-by-governcode" ]; then rm -rf -- "$d"; echo "Removed $d"
    elif [ -f "$d/VERSION" ] && [ -f "$d/target/release/govern-sup" ]; then
      echo "Kept $d: installed by an older install.sh without its mark; remove it yourself if it is yours"
    fi
  done
  rmdir "$root" 2>/dev/null || true
  state="${GOVERNCODE_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/governcode}"
  dash="$config/GovernCode Dashboard"
  if [ "$purge" = 1 ]; then
    if [ ! -d "$state" ]; then :
    elif [ ! -f "$state/.governcode-state" ]; then
      echo "Kept $state: govd did not create it (or it predates the mark); remove it yourself if it is only GovernCode's"
    elif [ -e "$state/.git" ]; then
      echo "Kept $state: it holds a git repository"
    else
      rm -rf -- "$state"; echo "Removed $state"
    fi
    if [ -d "$dash" ]; then rm -rf -- "$dash"; echo "Removed $dash"; fi
  else
    if [ -f "$state/.governcode-state" ] && [ ! -e "$state/.git" ]; then echo "Kept $state (the Trace and settings); --purge removes it"
    elif [ -d "$state" ]; then echo "Kept $state (the Trace and settings); remove it yourself if you no longer want it"; fi
    if [ -d "$dash" ]; then echo "Kept $dash (Dashboard settings); --purge removes it"; fi
  fi
  echo "Uninstall finished. Your projects were not touched."
  exit 0
fi

command -v node >/dev/null 2>&1 || { echo "GovernCode needs Node.js 22.18 or newer (not found)."; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || { echo "GovernCode needs Node.js 22.18 or newer (found $(node --version))."; exit 1; }

# Only a new folder, one this script marked, or an older install of this same release is ever
# marked (and so removable by --uninstall); anything else already at the destination is refused.
if [ -e "$dest" ] && [ ! -f "$dest/.installed-by-governcode" ] \
   && ! { [ "$(cat "$dest/VERSION" 2>/dev/null)" = "$ver" ] && [ -f "$dest/target/release/govern-sup" ]; }; then
  echo "$dest already exists and is not a GovernCode $ver install. Move it aside, or set GOVERNCODE_HOME."
  exit 1
fi
if [ "$here" != "$dest" ]; then
  mkdir -p "$dest"
  cp -a "$here/." "$dest/"
fi
# The mark `--uninstall` looks for: this folder was put here by install.sh.
echo "Installed by GovernCode install.sh; --uninstall removes this folder." > "$dest/.installed-by-governcode"
mkdir -p "$bindir"
for b in gov govd governcode-dashboard; do ln -sf "$dest/bin/$b" "$bindir/$b"; done
# The Dashboard in the desktop's app launcher (XDG desktop entry; the release's own logo).
mkdir -p "$apps"
cat > "$apps/governcode-dashboard.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=GovernCode Dashboard
Comment=Your AI coding crew: Gates, Specs, Checkpoints and Limits
Exec=$dest/bin/governcode-dashboard
Icon=$dest/docs/brand/governcode-mark.svg
Categories=Development;
Terminal=false
DESKTOP
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
  mkdir -p "$(dirname "$unit")"
  # The service gets this shell's PATH, the one whose Node passed the check above (and where the
  # AI tools are found). Early at login, systemd's own PATH can hold only an older system Node.
  # A PATH systemd could misread (a quote, a backslash, a newline) is left out.
  envline=""
  case "$PATH" in
    *[\"\\]* | *"
"*) echo "Your PATH has a quote, backslash or newline; the service uses systemd's PATH." ;;
    *) envline="Environment=\"PATH=$(printf '%s' "$PATH" | sed 's/%/%%/g')\"" ;;
  esac
  cat > "$unit" <<UNIT
[Unit]
Description=GovernCode daemon (govd)

[Service]
$envline
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
