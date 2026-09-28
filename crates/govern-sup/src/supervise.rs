//! The tool runs as our child; we stay outside the sandbox as its subreaper.
//!
//! `exec`-ing the tool in place (the old design) left nothing to clean up after it: a tool
//! could fork a detached worker (setsid, double fork), exit, and leave the worker running
//! with its sandbox but outside the run's lifetime. As a child subreaper we inherit every
//! orphan the tool leaves, and when the tool exits, or govd stops us, we kill them all.
//!
//! ponytail: if govern-sup itself is SIGKILLed, the tool gets SIGKILL (PDEATHSIG) but its
//! own children are reparented to init. govd stops runs with SIGTERM to the process group,
//! which we handle; upgrade to a per-run cgroup if a hard kill ever matters.

use std::os::unix::process::CommandExt;
use std::process::{Command, ExitCode};

/// Forks; the child calls `restrict` and executes argv. Returns the tool's exit status.
pub fn run(argv: &[String], restrict: impl FnOnce() -> Result<(), String>) -> Result<ExitCode, String> {
    let set = signals();
    let mut old: libc::sigset_t = unsafe { std::mem::zeroed() };
    unsafe {
        if libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0 {
            return Err(format!("cannot become the tool's reaper: {}", std::io::Error::last_os_error()));
        }
        // Blocked before fork so none is lost; the child restores the old mask.
        libc::sigprocmask(libc::SIG_BLOCK, &set, &mut old);
    }
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(format!("cannot start the tool: {}", std::io::Error::last_os_error()));
    }
    if pid == 0 {
        // The child: dies with us, restricted for good, then becomes the tool.
        unsafe {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0);
            libc::sigprocmask(libc::SIG_SETMASK, &old, std::ptr::null_mut());
        }
        let err = match restrict() {
            Ok(()) => {
                let e = Command::new(&argv[0]).args(&argv[1..]).exec();
                format!("cannot execute {}: {e} (is it under an exec path?)", argv[0])
            }
            Err(e) => e,
        };
        eprintln!("govern-sup: {err}");
        unsafe { libc::_exit(125) };
    }
    Ok(wait_for(pid, &set))
}

fn signals() -> libc::sigset_t {
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for s in [libc::SIGCHLD, libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::sigaddset(&mut set, s);
        }
        set
    }
}

/// Waits for the tool, passing on stop signals; then empties the house.
fn wait_for(tool: libc::pid_t, set: &libc::sigset_t) -> ExitCode {
    let mut status = None;
    while status.is_none() {
        let sig = unsafe { libc::sigwaitinfo(set, std::ptr::null_mut()) };
        if sig > 0 && sig != libc::SIGCHLD {
            unsafe { libc::kill(tool, sig) };
        }
        // Reap whatever finished: the tool, or orphans that were reparented to us.
        loop {
            let mut st = 0;
            let p = unsafe { libc::waitpid(-1, &mut st, libc::WNOHANG) };
            if p <= 0 {
                break;
            }
            if p == tool {
                status = Some(st);
            }
        }
    }
    kill_descendants();
    let st = status.unwrap_or(0);
    let code = if libc::WIFEXITED(st) { libc::WEXITSTATUS(st) } else { 128 + libc::WTERMSIG(st) };
    ExitCode::from(code.clamp(0, 255) as u8)
}

/// Kills every process below us until none is left. Children of killed processes are
/// reparented to us (we are their subreaper), so each pass finds what the last one exposed.
pub fn kill_descendants() {
    for _ in 0..1000 {
        let all = descendants(std::process::id() as libc::pid_t);
        if all.is_empty() {
            // Nothing alive below us; collect any zombies and stop.
            while unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) } > 0 {}
            return;
        }
        for pid in &all {
            unsafe { libc::kill(*pid, libc::SIGKILL) };
        }
        while unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) } > 0 {}
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

/// Every process below `pid`, from /proc/<pid>/task/<tid>/children, recursively.
fn descendants(pid: libc::pid_t) -> Vec<libc::pid_t> {
    let mut out = Vec::new();
    let mut todo = vec![pid];
    while let Some(p) = todo.pop() {
        let Ok(tasks) = std::fs::read_dir(format!("/proc/{p}/task")) else { continue };
        for t in tasks.flatten() {
            let Ok(text) = std::fs::read_to_string(t.path().join("children")) else { continue };
            for c in text.split_whitespace().filter_map(|c| c.parse::<libc::pid_t>().ok()) {
                out.push(c);
                todo.push(c);
            }
        }
    }
    out
}
