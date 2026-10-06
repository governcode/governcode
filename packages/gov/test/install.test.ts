import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../packaging/install.sh", import.meta.url));

// A fake release (the real install.sh, stub binaries) and a fake home; systemctl is a stub that
// records its arguments, so the test never touches the user's real service.
function setup() {
  const t = mkdtempSync(join(tmpdir(), "gc-install-"));
  const rel = join(t, "release"), fake = join(t, "fakebin"), home = join(t, "home");
  for (const d of [join(rel, "bin"), join(rel, "target/release"), join(rel, "docs/brand"), fake, home]) mkdirSync(d, { recursive: true });
  writeFileSync(join(rel, "VERSION"), "9.9.9-test\n");
  copyFileSync(script, join(rel, "install.sh"));
  for (const b of ["bin/gov", "bin/govd", "bin/governcode-dashboard", "target/release/govern-sup"]) {
    writeFileSync(join(rel, b), "#!/bin/sh\nexit 0\n"); chmodSync(join(rel, b), 0o755);
  }
  writeFileSync(join(fake, "systemctl"), `#!/bin/sh\necho "$*" >> "${join(t, "systemctl.log")}"\n`);
  chmodSync(join(fake, "systemctl"), 0o755);
  const env = {
    PATH: `${fake}:${process.env.PATH}`, HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
    GOVERNCODE_HOME: join(home, ".local/share/governcode"), GOVERNCODE_BIN: join(home, ".local/bin"),
  };
  const run = (...args: string[]) => spawnSync("sh", [join(rel, "install.sh"), ...args], { env, encoding: "utf8" });
  return { t, home, env, run, root: env.GOVERNCODE_HOME, bin: env.GOVERNCODE_BIN };
}

test("install.sh --uninstall removes what install put there, keeps state unless --purge, never touches other files", async () => {
  const s = setup();
  try {
    // A folder already at the destination that is not this release: refused, left alone.
    mkdirSync(join(s.root, "9.9.9-test"), { recursive: true }); writeFileSync(join(s.root, "9.9.9-test/notes.txt"), "mine");
    const refused = s.run();
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /already exists and is not a GovernCode 9\.9\.9-test install/);
    assert.ok(!existsSync(join(s.root, "9.9.9-test/.installed-by-governcode")));
    rmSync(join(s.root, "9.9.9-test"), { recursive: true });
    const inst = s.run("--service");
    assert.equal(inst.status, 0, inst.stdout + inst.stderr);
    const unit = join(s.home, ".config/systemd/user/governcode.service");
    const entry = join(s.home, ".local/share/applications/governcode-dashboard.desktop");
    assert.ok(existsSync(unit) && existsSync(entry) && existsSync(join(s.root, "9.9.9-test/VERSION")));
    // Things that are not GovernCode's: a link elsewhere, a folder without a release in it, state.
    rmSync(join(s.bin, "gov")); symlinkSync("/usr/bin/true", join(s.bin, "gov"));
    mkdirSync(join(s.root, "notes")); writeFileSync(join(s.root, "notes/keep.txt"), "mine");
    // A release-shaped folder this script did not install (an older install, or someone's copy).
    mkdirSync(join(s.root, "0.0.1/target/release"), { recursive: true });
    writeFileSync(join(s.root, "0.0.1/VERSION"), "0.0.1\n"); writeFileSync(join(s.root, "0.0.1/target/release/govern-sup"), "");
    const state = join(s.home, ".local/state/governcode"), dash = join(s.home, ".config/GovernCode Dashboard");
    mkdirSync(state, { recursive: true }); writeFileSync(join(state, "trace.sqlite"), "");   // not marked by govd yet
    mkdirSync(dash, { recursive: true });

    // Something still running from the install: refuse, remove nothing.
    const p = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", join(s.root, "9.9.9-test/bin/govd")], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 200));
    try {
      const busy = s.run("--uninstall");
      assert.equal(busy.status, 1);
      assert.match(busy.stdout, new RegExp(`process.* ${p.pid}\\b`));
      assert.match(busy.stdout, /Nothing was removed/);
      assert.ok(existsSync(join(s.root, "9.9.9-test")) && lstatSync(join(s.bin, "govd")).isSymbolicLink());
    } finally { p.kill(); }
    // Started from inside the release with a relative path: seen by its working folder.
    const q = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "bin/govd"], { stdio: "ignore", cwd: join(s.root, "9.9.9-test") });
    await new Promise((r) => setTimeout(r, 200));
    try {
      const busy = s.run("--uninstall");
      assert.equal(busy.status, 1);
      assert.match(busy.stdout, new RegExp(`process.* ${q.pid}\\b`));
    } finally { q.kill(); }
    await new Promise((r) => setTimeout(r, 100));

    const un = s.run("--uninstall");
    assert.equal(un.status, 0, un.stdout + un.stderr);
    assert.ok(!existsSync(unit) && !existsSync(entry));
    assert.ok(!existsSync(join(s.root, "9.9.9-test")));
    assert.ok(!existsSync(join(s.bin, "govd")) && !existsSync(join(s.bin, "governcode-dashboard")));
    assert.equal(execFileSync("readlink", [join(s.bin, "gov")], { encoding: "utf8" }).trim(), "/usr/bin/true", "a link elsewhere is kept");
    assert.equal(readFileSync(join(s.root, "notes/keep.txt"), "utf8"), "mine", "a folder that is not a release is kept");
    assert.ok(existsSync(join(s.root, "0.0.1/VERSION")), "an unmarked release is kept");
    assert.match(un.stdout, /Kept .*0\.0\.1: installed by an older install\.sh/);
    assert.ok(existsSync(state) && existsSync(dash), "state is kept without --purge");
    assert.match(un.stdout, /Kept .*governcode \(the Trace and settings\); remove it yourself/, "no --purge promise for unmarked state");
    assert.match(readFileSync(join(s.t, "systemctl.log"), "utf8"), /--user disable --now governcode\.service/);

    // --purge removes only a state folder govd marked, and never one holding a repository.
    const unmarked = s.run("--uninstall", "--purge");
    assert.ok(existsSync(join(state, "trace.sqlite")) && !existsSync(dash));
    assert.match(unmarked.stdout, /Kept .*: govd did not create it/);
    writeFileSync(join(state, ".governcode-state"), ""); mkdirSync(join(state, ".git"));
    assert.match(s.run("--uninstall", "--purge").stdout, /Kept .*: it holds a git repository/);
    assert.ok(existsSync(join(state, "trace.sqlite")), "a folder with .git in it is never purged");
    rmSync(join(state, ".git"), { recursive: true });
    const purge = s.run("--uninstall", "--purge");
    assert.equal(purge.status, 0, purge.stdout + purge.stderr);
    assert.ok(!existsSync(state));
    assert.match(s.run("--uninstall", "--nope").stdout, /Unknown option/);
  } finally { rmSync(s.t, { recursive: true, force: true }); }
});

test("install.sh --uninstall keeps a unit, link or launcher entry that is not GovernCode's", () => {
  const s = setup();
  try {
    const unit = join(s.home, ".config/systemd/user/governcode.service");
    mkdirSync(join(s.home, ".config/systemd/user"), { recursive: true });
    writeFileSync(unit, "[Unit]\nDescription=something else\n");
    mkdirSync(s.bin, { recursive: true }); symlinkSync("/usr/bin/true", join(s.bin, "govd"));
    const apps = join(s.home, ".local/share/applications");
    mkdirSync(apps, { recursive: true }); writeFileSync(join(apps, "governcode-dashboard.desktop"), "[Desktop Entry]\nExec=/usr/bin/true\n");
    const r = s.run("--uninstall");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(unit) && lstatSync(join(s.bin, "govd")).isSymbolicLink() && existsSync(join(apps, "governcode-dashboard.desktop")));
    assert.ok(!existsSync(join(s.t, "systemctl.log")), "systemctl never called for a unit that is not ours");
  } finally { rmSync(s.t, { recursive: true, force: true }); }
});

test("install.sh --service gives the service the PATH whose Node it checked", () => {
  const s = setup();
  try {
    const unit = join(s.home, ".config/systemd/user/governcode.service");
    const odd = join(s.t, "50%off");
    mkdirSync(odd);
    s.env.PATH = `${s.env.PATH}:${odd}`;
    assert.equal(s.run("--service").status, 0);
    const line = readFileSync(unit, "utf8").split("\n").find((l) => l.startsWith("Environment="));
    assert.equal(line, `Environment="PATH=${s.env.PATH.replaceAll("%", "%%")}"`);
    // A PATH systemd would misread is left out; systemd's own PATH is used.
    s.env.PATH = `${s.env.PATH}:${join(s.t, 'a"b')}`;
    const r = s.run("--service");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /the service uses systemd's PATH/);
    assert.ok(!readFileSync(unit, "utf8").includes("Environment="));
  } finally { rmSync(s.t, { recursive: true, force: true }); }
});
