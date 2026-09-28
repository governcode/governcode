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
    ("connect to a Unix socket the policy lists", true),
    ("write the daemon's state file", false),
    ("read the keyring file", false),
    ("write the tool's settings file", false),
    ("write outside the worktree", false),
    ("connect to the daemon's Unix socket", false),
    // The route that defeats protect mode: asking systemd --user (on the session bus) to run
    // something outside the sandbox. Checked only where the bus exists.
    ("reach the session bus (systemd --user)", false),
    ("write into an input FIFO by path (#177)", false),
    ("connect to loopback TCP on a non-listed port", false),
    ("bind a TCP port", false),
    ("run a binary outside the exec list", false),
    // Security review 2026-09-27.
    ("create System V shared memory", false),
    ("change a file's owner", false),
    ("use a descriptor inherited from outside", false),
    ("leave a process running after the tool exits", false),
];

/// The inherited descriptor's number: the self-test opens the keyring outside the sandbox
/// and hands it down on this fd; inside, reading it must fail.
const INHERITED_FD: i32 = 9;
const SURVIVOR: &str = "survivor.txt";

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
        "connect to a Unix socket the policy lists" => UnixStream::connect(dir.join("listed.sock")).is_ok(),
        "write the daemon's state file" => write(&dir.join("state/trace.db")),
        "read the keyring file" => fs::read(dir.join("keyring")).is_ok(),
        "write the tool's settings file" => write(&dir.join("settings.json")),
        "write outside the worktree" => write(&dir.join("outside.txt")),
        "connect to the daemon's Unix socket" => UnixStream::connect(dir.join("daemon.sock")).is_ok(),
        "reach the session bus (systemd --user)" => session_bus().map(|b| UnixStream::connect(b).is_ok()).unwrap_or(false),
        "write into an input FIFO by path (#177)" => OpenOptions::new().write(true)
            .custom_flags(libc::O_NONBLOCK).open(dir.join("input.fifo")).is_ok(),
        "connect to loopback TCP on a non-listed port" => TcpStream::connect(("127.0.0.1", port)).is_ok(),
        "bind a TCP port" => TcpListener::bind(("127.0.0.1", 0)).is_ok(),
        "run a binary outside the exec list" => Command::new(dir.join("bin/not-allowed")).status().is_ok(),
        "create System V shared memory" => {
            let id = unsafe { libc::shmget(libc::IPC_PRIVATE, 4096, libc::IPC_CREAT | 0o600) };
            if id >= 0 {
                unsafe { libc::shmctl(id, libc::IPC_RMID, std::ptr::null_mut()) };
            }
            id >= 0
        }
        "change a file's owner" => {
            let f = wt.join("owned.txt");
            let _ = fs::write(&f, b"x");
            let c = std::ffi::CString::new(f.to_string_lossy().as_bytes()).unwrap_or_default();
            unsafe { libc::chown(c.as_ptr(), libc::getuid(), libc::getgid()) == 0 }
        }
        "use a descriptor inherited from outside" => {
            let mut buf = [0u8; 6];
            unsafe { libc::pread(INHERITED_FD, buf.as_mut_ptr().cast(), buf.len(), 0) == 6 }
        }
        // Starts a detached worker that writes a file a second later; the self-test looks
        // for that file after the run is over. Here it only reports that the worker started.
        "leave a process running after the tool exits" => {
            use std::os::unix::process::CommandExt;
            let mut cmd = Command::new("/usr/bin/sh");
            cmd.arg("-c").arg(format!("sleep 1; echo x > {}", wt.join(SURVIVOR).display()))
                .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            unsafe { cmd.pre_exec(|| { libc::setsid(); Ok(()) }) };
            cmd.spawn().is_ok()
        }
        _ => false,
    }
}

/// The user's session bus socket, if this machine has one.
fn session_bus() -> Option<PathBuf> {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")?;
    let bus = PathBuf::from(runtime).join("bus");
    bus.exists().then_some(bus)
}

pub fn main(args: &[String]) -> Result<ExitCode, String> {
    let json = args.iter().any(|a| a == "--json");
    let me = std::env::current_exe().map_err(|e| format!("cannot find myself: {e}"))?;
    // A fresh, unpredictable, private directory that did not exist before: the unsandboxed
    // control run writes into it, so a preplanted one (or a symlink in it) must never be
    // used (security review 2026-09-27).
    let mut rnd = [0u8; 12];
    if unsafe { libc::getrandom(rnd.as_mut_ptr().cast(), rnd.len(), 0) } != rnd.len() as isize {
        return Err("self-test setup: no randomness for a private directory".into());
    }
    let name: String = rnd.iter().map(|b| format!("{b:02x}")).collect();
    let dir = std::env::temp_dir().join(format!("govern-sup-selftest-{name}"));
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(&dir).map_err(|e| format!("self-test setup: {e}"))?;
    }
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
    // Stands for the DNS resolver's socket: listed, so it must work while daemon.sock stays out.
    let _listed = UnixListener::bind(dir.join("listed.sock")).map_err(io)?;
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
        "unix_connect": [dir.join("listed.sock")],
        "cwd": dir.join("worktree"),
    });
    let policy_file = dir.join("policy.json");
    fs::write(&policy_file, policy.to_string()).map_err(io)?;

    // The keyring, open outside the sandbox and handed down as fd 9 without close-on-exec.
    let keyring = fs::File::open(dir.join("keyring")).map_err(io)?;
    let key_fd = { use std::os::fd::AsRawFd; keyring.as_raw_fd() };
    let with_inherited = |cmd: &mut Command| {
        use std::os::unix::process::CommandExt;
        unsafe { cmd.pre_exec(move || { if libc::dup2(key_fd, INHERITED_FD) < 0 { return Err(std::io::Error::last_os_error()); } Ok(()) }) };
    };
    let survivor = dir.join("worktree").join(SURVIVOR);
    // After a run, did the detached worker live on long enough to write its file?
    let survived = || { std::thread::sleep(std::time::Duration::from_millis(1600)); survivor.exists() };

    // Control run, unsandboxed: every check must work here, or a fixture is broken and a
    // "refused" inside the sandbox would prove nothing.
    let mut cmd = Command::new(me);
    cmd.arg("check").arg(dir).arg(port.to_string());
    with_inherited(&mut cmd);
    let control = cmd.output().map_err(io)?;
    let control_survived = survived();
    let broken: Vec<String> = String::from_utf8_lossy(&control.stdout).lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(n, r)| (n, if n == "leave a process running after the tool exits" { control_survived } else { r == "worked" }))
        .filter(|(n, worked)| !*worked && !(*n == "reach the session bus (systemd --user)" && session_bus().is_none()))
        .map(|(n, _)| n.to_string()).collect();
    if !control.status.success() || !broken.is_empty() {
        return Err(format!("self-test fixtures are broken (these failed even unsandboxed: {})", broken.join(", ")));
    }
    for leftover in ["state/trace.db", "settings.json", "outside.txt", "worktree/probe.txt"] {
        let _ = fs::write(dir.join(leftover), b"reset");
    }
    let _ = fs::remove_file(&survivor);

    let mut cmd = Command::new(me);
    cmd.args(["run", "--policy"]).arg(&policy_file).arg("--").arg(me).arg("check").arg(dir).arg(port.to_string());
    with_inherited(&mut cmd);
    let out = cmd.output().map_err(io)?;
    let sandbox_survived = survived();
    if !out.status.success() {
        return Err(format!("the sandbox could not start: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let seen: Vec<(String, bool)> = String::from_utf8_lossy(&out.stdout).lines()
        .filter_map(|l| l.split_once('\t').map(|(n, r)| (n.to_string(),
            if n == "leave a process running after the tool exits" { sandbox_survived } else { r == "worked" }))).collect();

    let mut all_ok = seen.len() == CHECKS.len();
    let mut rows = Vec::new();
    // Below Landlock ABI 9 the sandbox refuses every new Unix socket (seccomp), so a listed
    // socket is expected to be refused there too: stricter, never looser.
    let abi = crate::sandbox::kernel_abi();
    for (name, allowed) in CHECKS {
        let expect_allowed = if *name == "connect to a Unix socket the policy lists" { abi >= 9 } else { *allowed };
        let worked = seen.iter().find(|(n, _)| n == name).map(|(_, w)| *w);
        let ok = worked == Some(expect_allowed);
        all_ok &= ok;
        rows.push((name, expect_allowed, worked, ok));
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
