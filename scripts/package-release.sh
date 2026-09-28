#!/usr/bin/env bash
# Builds the Linux release: scripts/package-release.sh VERSION   (e.g. 0.1.0-motion.1)
# Output: dist-release/governcode-VERSION-linux-x86_64.tar.gz and SHA256SUMS.
# The tarball keeps the repository's layout, so govd finds govern-sup and the Dashboard
# finds Electron exactly as in a checkout; nothing in the code knows it was packaged.
set -euo pipefail
ver=${1:?usage: package-release.sh VERSION}
case "$ver" in *[!A-Za-z0-9.-]*) echo "bad version: $ver" >&2; exit 2;; esac
root=$(cd "$(dirname "$0")/.." && pwd)
name="governcode-$ver-linux-x86_64"
out="$root/dist-release"
st="$out/$name"
rm -rf "$st" "$out"/*.tar.gz "$out/SHA256SUMS"
mkdir -p "$st"
cd "$root"

npm ci
# npm 11 no longer runs dependencies' install scripts by default, and Electron's fetches its
# runtime; run it on purpose (it verifies the download against Electron's own checksums).
node node_modules/electron/install.js
test -x node_modules/electron/dist/electron || { echo "Electron runtime missing" >&2; exit 1; }
# No build machine's paths in the binary (Rust embeds source paths for panic messages):
# the home folder and this checkout become fixed placeholders.
RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=/home/build --remap-path-prefix=$root=/src" \
  cargo build --release --locked --target-dir "$out/cargo"
npm run build -w apps/dashboard

mkdir -p "$st/target/release" "$st/node_modules/@governcode" "$st/apps/dashboard" "$st/bin"
cp "$out/cargo/release/govern-sup" "$st/target/release/"
for p in protocol govd gov; do
  mkdir -p "$st/packages/$p"
  cp -r "packages/$p/package.json" "packages/$p/src" "$st/packages/$p/"
  ln -s "../../packages/$p" "$st/node_modules/@governcode/$p"
done
cp -r apps/dashboard/package.json apps/dashboard/dist "$st/apps/dashboard/"
ln -s ../../apps/dashboard "$st/node_modules/@governcode/dashboard"
# Runtime dependencies only: zod (protocol) and Electron (the Dashboard's runtime).
cp -r node_modules/zod node_modules/electron "$st/node_modules/"
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json"));p.version=process.argv[1];delete p.devDependencies;fs.writeFileSync(process.argv[2],JSON.stringify(p,null,2)+"\n")' "$ver" "$st/package.json"
echo "$ver" > "$st/VERSION"
cp LICENSE README.md SECURITY.md "$st/"
cp -r docs "$st/"
cp packaging/bin/* "$st/bin/"
cp packaging/install.sh "$st/install.sh"
chmod 755 "$st/bin/"* "$st/install.sh"

tar -C "$out" --owner=0 --group=0 -czf "$out/$name.tar.gz" "$name"
(cd "$out" && sha256sum "$name.tar.gz" > SHA256SUMS)
echo "built $out/$name.tar.gz"
