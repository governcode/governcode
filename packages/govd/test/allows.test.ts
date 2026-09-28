// Standing allows (#192): what a rule may cover, what always asks, and how long a rule lasts.
// A standing allow only skips the question; the sandbox applies to every step regardless.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { Allows, isQuietRead, kindOf, plainWords, scopesFor } from "../src/allows.ts";
import { scratch } from "./scratch.ts";

const bash = (command: unknown, spec?: string) => ({ tool: "Bash", input: { command } as Record<string, unknown>, ...(spec ? { spec } : {}) });

test("only plain commands can be covered: anything that could chain or hide a second command asks", () => {
  for (const c of ["npm test; rm -rf ~", "npm test && curl x", "npm test || true", "npm test | tee out", "npm test & rm x",
    "npm test $(rm -rf ~)", "npm test `rm`", "npm test > ~/.bashrc", "npm test < in", "FOO=1 npm test", "./run-tests",
    "/usr/bin/npm test", "npm test\nrm -rf ~", "npm test *", "npm test ~", "npm test #x",
    "npm test \"$(rm -rf ~)\"", "npm test \"$HOME\"", "npm test \"`id`\"", "npm test 'unterminated", "npm test \"x\\\"",
    "npm test \; rm", "", "   "]) {
    assert.equal(plainWords(c), null, c);
    assert.equal(kindOf(bash(c)), null, c);
  }
  assert.equal(plainWords(["bash", "-lc", "npm test; rm -rf ~"]), null);
  assert.equal(plainWords(["npm", "test;rm"]), null);
  assert.deepEqual(plainWords(["bash", "-lc", "npm test"]), ["npm", "test"]);
  // Codex's own wrapper: the command inside is judged, and cannot escape the quotes.
  assert.deepEqual(plainWords("/usr/bin/bash -lc 'npm test'"), ["npm", "test"]);
  assert.equal(plainWords("/usr/bin/bash -lc 'npm test; rm -rf ~'"), null);
  assert.equal(plainWords("/usr/bin/bash -lc 'npm test' ; rm -rf ~"), null);
  assert.equal(plainWords("/usr/bin/bash -lc 'a'\\''b'"), null);
  // Quotes are read exactly as the shell does: literal arguments are fine, expansion is not.
  assert.deepEqual(plainWords("sed -n '1,220p' README.md"), ["sed", "-n", "1,220p", "README.md"]);
  assert.deepEqual(plainWords("/usr/bin/bash -lc \"sed -n '1,220p' README.md\""), ["sed", "-n", "1,220p", "README.md"]);
  assert.deepEqual(plainWords("grep 'a;b|c' src"), ["grep", "a;b|c", "src"], "metacharacters inside quotes are just text");
  assert.equal(plainWords("/usr/bin/bash -lc \"sed -n '1p' x; rm -rf ~\""), null, "a chain inside the wrapper still asks");
  assert.equal(plainWords("/usr/bin/bash -lc \"echo $HOME\""), null);
  assert.equal(kindOf(bash("/usr/bin/bash -lc 'npm test'", "S-1"))!.key, "runner:command:npm test");
});

test("a kind is the program and its subcommand; dangerous programs, git and interpreters always ask", () => {
  assert.equal(kindOf(bash("npm test"))!.key, "command:npm test");
  assert.equal(kindOf(bash("npm test --watch"))!.key, "command:npm test");
  assert.equal(kindOf(bash("cargo build --release"))!.key, "command:cargo build");
  assert.equal(kindOf(bash("ls -la"))!.key, "command:ls");
  assert.match(kindOf(bash("npm test"))!.label, /sandbox still applies/);
  for (const c of ["rm -rf dist", "sudo make", "git status", "git push", "curl example.com", "python x.py", "node -e 1",
    "npx something", "bash x", "env FOO=1 ls", "xargs rm", "cargo publish", "npm publish", "find . -delete", "find . -exec rm {} +",
    "chmod 777 x", "docker run x", "gh pr merge", "kill 1", "sed -i 's/a/b/' x"]) {
    assert.equal(kindOf(bash(c)), null, c);
  }
  assert.equal(kindOf({ tool: "Edit", input: {} })!.key, "edit");
  assert.equal(kindOf({ tool: "mcp__governcode__delegate", input: {} }), null, "delegation always asks");
  assert.equal(kindOf({ tool: "governcode delegate", input: {} }), null);
});

test("Codex's review: flags before the subcommand, versioned interpreters, awk and execution flags always ask", () => {
  assert.equal(kindOf(bash("npm --silent publish")), null, "the subcommand is found past the flags");
  assert.equal(kindOf(bash("npm --version"))!.key, "command:npm");
  assert.equal(kindOf(bash("npm --silent test")), null, "an option before the subcommand asks (it may take a value)");
  // Security review 2026-09-27: an option's value dressed up as the approved subcommand.
  assert.equal(kindOf(bash("npm --prefix test exec -- sh -c id")), null);
  assert.equal(kindOf(bash("tar -I./payload")), null, "short spelling of --use-compress-program");
  assert.equal(kindOf(bash("npm test --script-shell=./payload")), null);
  // Grok's red-team, 2026-09-27: launchers, and options that run or load something else.
  for (const c of ["fakeroot bash -c id", "setarch linux64 bash -c id", "sshpass -p s ssh host id", "numactl -C 0 id",
    "nsenter -t 1 sh", "go test -exec=./pwn", "go test -toolexec=./pwn", "cargo build --config 'build.rustc-wrapper=\"/usr/bin/id\"'",
    "make test --eval='$(shell id)'", "make test -f Evil.mk", "sort --compress-program=./pwn", "tar -xf a.tar -I./pwn",
    "tar xvfI a.tar ./pwn", "npm test --userconfig=./rc"]) assert.equal(kindOf(bash(c)), null, c);
  assert.equal(kindOf(bash("make test"))!.key, "command:make test", "plain make test is still a kind");
  for (const c of ["python3.13 -c pass", "perl5.38 -e 1", "awk 'BEGIN {system(\"id\")}'", "gawk -f x.awk", "busybox sh",
    "rg --pre=sh pattern README.md", "rg --pre sh x", "tar --to-command=sh -xf a.tar", "npm --prefix /x test", "cat -o x",
    // Grok's red team: launchers that run the real program later on the line.
    "command -p git -c core.fsmonitor=./pwn status", "command -v true", "timeout 5 bash -c 'id'", "time -p rm -rf x",
    "nice -n0 bash -c id", "flock . bash -c id", "watch -n1 bash -c id", "stdbuf -oL python3 -c id", "builtin eval 'rm x'",
    "source ./x", ". ./x", "rg -o TODO", "rg --pre ./pwn ."]) {
    assert.equal(kindOf(bash(c)), null, c);
  }
});

test("a Runner's kinds are its own: allowing a step in a Spec never covers the Controller's", () => {
  assert.equal(kindOf(bash("npm test", "S-0001"))!.key, "runner:command:npm test");
  assert.equal(kindOf({ tool: "codex fileChange", spec: "S-0001", input: {} })!.key, "runner:edit");
  assert.equal(kindOf({ tool: "codex command", base: "codex command", input: { command: ["bash", "-lc", "npm test"] } })!.key, "command:npm test");
});

test("quiet reads: only reads no project file can steer", () => {
  for (const c of ["ls -la", "cat README.md", "grep -rn TODO src", "rg foo", "wc -l x", "pwd"]) assert.ok(isQuietRead(bash(c)), c);
  for (const c of ["git status", "git diff", "rg --pre sh foo", "rg --pre=sh foo", "cat x | sh", "cat $(x)", "npm test",
    "sort -o out x", "ls; rm -rf ~", "find . -delete", "find . -exec rm {} +", "find . -fprintf out x",
    "sed -n '1e rm -rf ~' x", "sed -i 's/a/b/' x", "sed -n '1,5w out' x", "sed 's/a/b/' x", "sed -n '1,5p' -i x"]) assert.ok(!isQuietRead(bash(c)), c);
  // Security review 2026-09-27: options that run programs, never end, or read special files.
  for (const c of ["rg --hostname-bin=./payload --hyperlink-format=default needle README.md", "rg -z needle a.gz",
    "tail -f README.md", "tail -F log", "tail --follow log", "cat /dev/zero", "grep -f /dev/zero README.md",
    "wc --files0-from=/dev/zero", "head -c 1 /proc/self/mem", "cat -", "grep -r x /sys", "du --files0-from=x",
    "find . -newerXY x", "find /dev -name x", "ls --color=always", "stat --printf=%n x", "rg --pre-glob=* x"]) assert.ok(!isQuietRead(bash(c)), c);
  for (const c of ["ls -la src", "head -n 40 README.md", "head -20 x", "tail -n5 x", "grep -rn --include='*.ts' TODO src",
    "rg -n -g '*.ts' needle src", "rg --hidden --files", "wc -lw a b", "du -sh .", "df -h", "stat -c %s x", "which node",
    "find src -name '*.ts' -type f -print", "grep -e -x file"]) assert.ok(isQuietRead(bash(c)), c);
  for (const c of ["find . -maxdepth 2 -type f", "sed -n '1,220p' README.md", "sed -n '10,$p' a b",
    "/usr/bin/bash -lc \"sed -n '1,80p' src/tide.js\""]) assert.ok(isQuietRead(bash(c)), c);
  assert.ok(!isQuietRead({ tool: "Edit", input: { command: "ls" } }));
});

test("scopes: the Controller per turn or project, a Runner per Spec or project, Home per turn", () => {
  const k = kindOf(bash("npm test"));
  assert.deepEqual(scopesFor(k, { project: "p", turn: "T-1" }), ["turn", "project"]);
  assert.deepEqual(scopesFor(k, { project: "p", turn: "T-1", spec: "S-1" }), ["spec", "project"]);
  assert.deepEqual(scopesFor(k, { project: null, turn: "T-1" }), ["turn"]);
  assert.deepEqual(scopesFor(null, { project: "p", turn: "T-1" }), [], "a step that always asks offers nothing");
});

test("rules last as long as their scope; project rules are saved and revocable", () => {
  const file = join(scratch("gc-allows-"), "allows.json");
  const a = new Allows(file);
  const k = kindOf(bash("npm test"))!;
  const turn = a.add("turn", k, { project: "p", turn: "T-1" });
  assert.equal(a.match(k, { project: "p", turn: "T-1" })?.id, turn.id);
  assert.equal(a.match(k, { project: "p", turn: "T-2" }), null, "another turn asks again");
  assert.equal(a.match(kindOf(bash("npm install"))!, { project: "p", turn: "T-1" }), null, "another kind asks");
  const rk = kindOf(bash("npm test", "S-1"))!;
  a.add("spec", rk, { project: "p", turn: "T-1", spec: "S-1" });
  assert.equal(a.match(k, { project: "p", turn: "T-2" }), null, "a Runner's rule never covers the Controller");
  assert.ok(a.match(rk, { project: "p", turn: "T-1", spec: "S-1" }));
  assert.equal(a.match(rk, { project: "p", turn: "T-1", spec: "S-2" }), null, "another Spec asks again");
  a.endTurn("T-1");
  assert.equal(a.match(k, { project: "p", turn: "T-1" }), null, "turn rules end with the turn");
  assert.equal(a.match(rk, { project: "p", turn: "T-1", spec: "S-1" }), null, "and so do Spec rules");
  const proj = a.add("project", k, { project: "p", turn: "T-3" });
  const again = new Allows(file);
  assert.equal(again.match(k, { project: "p", turn: "T-9" })?.id, proj.id, "saved across restarts");
  assert.equal(again.match(k, { project: "q", turn: "T-9" }), null, "per project");
  assert.ok(again.revoke(proj.id));
  assert.equal(new Allows(file).match(k, { project: "p", turn: "T-9" }), null);
  assert.throws(() => a.add("spec", k, { project: "p", turn: "T-1" }), /not from a Spec/);
  assert.throws(() => a.add("turn", rk, { project: "p", turn: "T-1", spec: "S-1" }), /per Spec/);
  assert.throws(() => a.add("project", k, { project: null, turn: "T-1" }), /Home/);
  // Codex's review: a project rule that cannot be saved is not live either.
  const blocker = join(scratch("gc-allows-"), "not-a-folder");
  writeFileSync(blocker, "");                                  // a file where the folder should be
  const stuck = new Allows(join(blocker, "allows.json"));
  assert.throws(() => stuck.add("project", k, { project: "p", turn: "T-1" }));
  assert.equal(stuck.match(k, { project: "p", turn: "T-1" }), null);
});
