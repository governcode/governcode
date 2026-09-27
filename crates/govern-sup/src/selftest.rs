//! `govern-sup selftest`: proves the sandbox on this machine. It builds dummy targets in a
//! temp dir (a stand-in daemon socket and state file, a keyring file, a read-only settings
//! file, a FIFO standing for an input channel, a loopback TCP listener, a binary outside the
//! exec list), then re-runs itself as `check` INSIDE a real sandbox. Every "denied" check
//! must fail and every "allowed" check must work; any other result fails the self-test.
//! A control run without the sandbox first proves every denied check would otherwise work.
//! Process-level rules (ptrace and friends) are covered by the seccomp unit tests.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

/// (name, expected to be allowed?)
const CHECKS: &[(&str, bool)] = &[
    ("write inside the worktree", true),
    ("read a read-only file", true),
    ("run an allowed binary", true),
    ("use a stream socketpair", true),
    ("write the daemon's state file", false),
    ("read the keyring file", false),
    ("write the tool's settings file", false),
    ("write outside the worktree", false),
    ("connect to the daemon's Unix socket", false),
    ("write into an input FIFO by path (#177)", false),
    ("connect to loopback TCP on a non-listed port", false),
    ("bind a TCP port", false),
    ("run a binary outside the exec list", false),
];

/// Runs inside the sandbox. `dir` is the self-test's temp dir; `port` its TCP listener.
pub fn check(args: &[String]) -> Result<ExitCode, String> {
    let (dir, port) = match args {
        [d, p] => (PathBuf::from(d), p.parse::<u16>().map_err(|e| format!("bad port: {e}"))?),
        _ => return Err("usage: govern-sup check DIR PORT".into()),
    };
    let wt = dir.join("worktree");
    for (name, _) in CHECKS {
        let worked = attempt(name, &dir, &wt, port);
        println!("{}\t{}", name, if worked { "worked" } else { "refused" });
    }
    Ok(ExitCode::SUCCESS)
}

fn attempt(name: &str, dir: &Path, wt: &Path, port: u16) -> bool {
    let write = |p: &Path| OpenOptions::new().write(true).create(true).truncate(true).open(p).and_then(|mut f| f.write_all(b"x")).is_ok();
    match name {
        "write inside the worktree" => write(&wt.join("probe.txt")) && fs::read(wt.join("probe.txt")).is_ok(),
        "read a read-only file" => fs::read(dir.join("settings.json")).is_ok(),
        "run an allowed binary" => Command::new("/usr/bin/true").status().map(|s| s.success()).unwrap_or(false),
        "use a stream socketpair" => UnixStream::pair().is_ok(),
        "write the daemon's state file" => write(&dir.join("state/trace.db")),
        "read the keyring file" => fs::read(dir.join("keyring")).is_ok(),
        "write the tool's settings file" => write(&dir.join("settings.json")),
        "write outside the worktree" => write(&dir.join("outside.txt")),
        "connect to the daemon's Unix socket" => UnixStream::connect(dir.join("daemon.sock")).is_ok(),
        "write into an input FIFO by path (#177)" => OpenOptions::new().write(true)
            .custom_flags(libc::O_NONBLOCK).open(dir.join("input.fifo")).is_ok(),
        "connect to loopback TCP on a non-listed port" => TcpStream::connect(("127.0.0.1", port)).is_ok(),
        "bind a TCP port" => TcpListener::bind(("127.0.0.1", 0)).is_ok(),
        "run a binary outside the exec list" => Command::new(dir.join("bin/not-allowed")).status().is_ok(),
        _ => false,
    }
}

pub fn main(args: &[String]) -> Result<ExitCode, String> {
    let json = args.iter().any(|a| a == "--json");
    let me = std::env::current_exe().map_err(|e| format!("cannot find myself: {e}"))?;
    let dir = std::env::temp_dir().join(format!("govern-sup-selftest-{}", std::process::id()));
    let result = run(&me, &dir, json);
    let _ = fs::remove_dir_all(&dir);
    result
}

fn run(me: &Path, dir: &Path, json: bool) -> Result<ExitCode, String> {
    let io = |e: std::io::Error| format!("self-test setup: {e}");
    for sub in ["worktree", "state", "bin"] {
        fs::create_dir_all(dir.join(sub)).map_err(io)?;
    }
    fs::write(dir.join("state/trace.db"), b"state").map_err(io)?;
    fs::write(dir.join("keyring"), b"secret").map_err(io)?;
    fs::write(dir.join("settings.json"), b"{}").map_err(io)?;
    fs::copy("/usr/bin/true", dir.join("bin/not-allowed")).map_err(io)?;
    let _daemon = UnixListener::bind(dir.join("daemon.sock")).map_err(io)?;
    let tcp = TcpListener::bind(("127.0.0.1", 0)).map_err(io)?;
    let port = tcp.local_addr().map_err(io)?.port();
    let fifo = dir.join("input.fifo");
    let c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    if unsafe { libc::mkfifo(c.as_ptr(), 0o600) } != 0 {
        return Err(format!("self-test setup: mkfifo: {}", std::io::Error::last_os_error()));
    }
    // A reader on the FIFO, so an unsandboxed writer would succeed: the refusal must come
    // from the sandbox, not from "no reader".
    let _reader = OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(&fifo).map_err(io)?;

    let exe_dir = me.parent().ok_or("cannot find my directory")?;
    let policy = serde_json::json!({
        "version": 1,
        "read": ["/usr", "/etc", "/lib", "/lib64", "/bin", "/proc", "/dev", dir.join("settings.json")],
        "write": [dir.join("worktree"), "/dev/null"],
        "exec": ["/usr/bin", "/bin", "/usr/lib", "/lib", "/lib64", exe_dir],
        "tcp_connect": [443],
        "cwd": dir.join("worktree"),
    });
    let policy_file = dir.join("policy.json");
    fs::write(&policy_file, policy.to_string()).map_err(io)?;

    // Control run, unsandboxed: every check must work here, or a fixture is broken and a
    // "refused" inside the sandbox would prove nothing.
    let control = Command::new(me).arg("check").arg(dir).arg(port.to_string()).output().map_err(io)?;
    let broken: Vec<String> = String::from_utf8_lossy(&control.stdout).lines()
        .filter_map(|l| l.split_once('\t')).filter(|(_, r)| *r != "worked").map(|(n, _)| n.to_string()).collect();
    if !control.status.success() || !broken.is_empty() {
        return Err(format!("self-test fixtures are broken (these failed even unsandboxed: {})", broken.join(", ")));
    }
    for leftover in ["state/trace.db", "settings.json", "outside.txt", "worktree/probe.txt"] {
        let _ = fs::write(dir.join(leftover), b"reset");
    }

    let out = Command::new(me)
        .args(["run", "--policy"]).arg(&policy_file).arg("--").arg(me)
        .arg("check").arg(dir).arg(port.to_string())
        .output().map_err(io)?;
    if !out.status.success() {
        return Err(format!("the sandbox could not start: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let seen: Vec<(String, bool)> = String::from_utf8_lossy(&out.stdout).lines()
        .filter_map(|l| l.split_once('\t').map(|(n, r)| (n.to_string(), r == "worked"))).collect();

    let mut all_ok = seen.len() == CHECKS.len();
    let mut rows = Vec::new();
    for (name, expect_allowed) in CHECKS {
        let worked = seen.iter().find(|(n, _)| n == name).map(|(_, w)| *w);
        let ok = worked == Some(*expect_allowed);
        all_ok &= ok;
        rows.push((name, *expect_allowed, worked, ok));
    }
    if json {
        let items: Vec<_> = rows.iter().map(|(n, allowed, worked, ok)| serde_json::json!({
            "check": n, "expected": if *allowed { "allowed" } else { "refused" },
            "result": match worked { Some(true) => "worked", Some(false) => "refused", None => "missing" }, "pass": ok,
        })).collect();
        println!("{}", serde_json::json!({ "pass": all_ok, "checks": items }));
    } else {
        for (n, allowed, worked, ok) in &rows {
            let got = match worked { Some(true) => "worked", Some(false) => "refused", None => "missing" };
            println!("{}  {:<46} expected {:<8} got {}", if *ok { "PASS" } else { "FAIL" }, n,
                     if *allowed { "allowed" } else { "refused" }, got);
        }
        println!("{}", if all_ok { "self-test passed" } else { "self-test FAILED" });
    }
    Ok(if all_ok { ExitCode::SUCCESS } else { ExitCode::from(1) })
}
