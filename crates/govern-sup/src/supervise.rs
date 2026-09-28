//! The tool runs as our child; we stay outside the sandbox as its subreaper.
//!
//! `exec`-ing the tool in place (the old design) left nothing to clean up after it: a tool
//! could fork a detached worker (setsid, double fork), exit, and leave the worker running
//! with its sandbox but outside the run's lifetime. As a child subreaper we inherit every
//! orphan the tool leaves, and when the tool exits, or govd stops us, we kill them all.
//!
//! Only our own children are ever signalled: a child's pid cannot be reused until we reap
//! it, so a kill never lands on an unrelated process. Killing a child hands its children to
//! us, and the next pass kills those. `waitpid` decides when we are done, not /proc.
//!
//! ponytail: if govern-sup itself is SIGKILLed, the tool gets SIGKILL (PDEATHSIG) but its
//! own children are reparented to init, and the tool may clear PDEATHSIG. govd stops runs
//! with SIGTERM to the process group, which we handle; upgrade to a per-run cgroup if a hard
//! kill of the supervisor ever matters.

use std::os::unix::process::CommandExt;
use std::process::{Command, ExitCode};
use std::time::{Duration, Instant};

/// How long a stopped tool gets to exit on its own before everything is killed.
const GRACE: Duration = Duration::from_secs(3);

/// Forks; the child calls `restrict` and executes argv. Returns the tool's exit status, or
/// re-raises the signal that killed it.
pub fn run(argv: &[String], restrict: impl FnOnce() -> Result<(), String>) -> Result<ExitCode, String> {
    let set = signals();
    let mut old: libc::sigset_t = unsafe { std::mem::zeroed() };
    let me = unsafe { libc::getpid() };
    unsafe {
        // An inherited "ignore SIGCHLD" would make the kernel reap the tool for us, and we
        // would never learn how it ended.
        libc::signal(libc::SIGCHLD, libc::SIG_DFL);
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
        // The child: dies with us (checked after registering, closing the fork race),
        // restricted for good, then becomes the tool.
        unsafe {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0);
            if libc::getppid() != me {
                libc::_exit(125);
            }
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
    let status = wait_for(pid, &set);
    if let Err(e) = kill_descendants() {
        // Fail closed: never report a clean run when something may still be running.
        eprintln!("govern-sup: {e}");
        return Ok(ExitCode::from(125));
    }
    Ok(finish(status))
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

enum Ended {
    Status(i32),
    /// We were told to stop, and the tool did not end within the grace period.
    Stopped(i32),
}

/// Waits for the tool. A stop signal is passed on; if the tool has not exited within GRACE,
/// the caller kills everything.
fn wait_for(tool: libc::pid_t, set: &libc::sigset_t) -> Ended {
    let mut deadline: Option<(Instant, i32)> = None;
    loop {
        // Reap what finished: the tool, or orphans that were reparented to us.
        loop {
            let mut st = 0;
            let p = unsafe { libc::waitpid(-1, &mut st, libc::WNOHANG) };
            if p <= 0 {
                break;
            }
            if p == tool {
                return Ended::Status(st);
            }
        }
        let timeout = match deadline {
            Some((at, sig)) => {
                let left = at.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Ended::Stopped(sig);
                }
                left
            }
            None => Duration::from_secs(3600),
        };
        let ts = libc::timespec { tv_sec: timeout.as_secs() as libc::time_t, tv_nsec: timeout.subsec_nanos() as libc::c_long };
        let sig = unsafe { libc::sigtimedwait(set, std::ptr::null_mut(), &ts) };
        if sig > 0 && sig != libc::SIGCHLD {
            unsafe { libc::kill(tool, sig) };
            if deadline.is_none() {
                deadline = Some((Instant::now() + GRACE, sig));
            }
        }
    }
}

/// The tool's own way of ending, passed on: its exit code, or the same signal on us.
fn finish(end: Ended) -> ExitCode {
    let sig = match end {
        Ended::Status(st) if libc::WIFEXITED(st) => return ExitCode::from(libc::WEXITSTATUS(st) as u8),
        Ended::Status(st) => libc::WTERMSIG(st),
        Ended::Stopped(sig) => sig,
    };
    unsafe {
        libc::signal(sig, libc::SIG_DFL);
        let mut one: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut one);
        libc::sigaddset(&mut one, sig);
        libc::sigprocmask(libc::SIG_UNBLOCK, &one, std::ptr::null_mut());
        libc::raise(sig);
    }
    ExitCode::from((128 + sig).clamp(0, 255) as u8)
}

/// Kills every process below us until `waitpid` says no child is left.
pub fn kill_descendants() -> Result<(), String> {
    let started = Instant::now();
    loop {
        let mut st = 0;
        match unsafe { libc::waitpid(-1, &mut st, libc::WNOHANG) } {
            p if p > 0 => continue, // reaped one; look again
            -1 if std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD) => return Ok(()),
            _ => {}
        }
        // Children exist. Signal each one we can see; its own children come to us next.
        for child in children()? {
            unsafe { libc::kill(child, libc::SIGKILL) };
        }
        if started.elapsed() > Duration::from_secs(30) {
            return Err("processes the tool started would not die within 30 s".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Our own children, from /proc/self/task/*/children. Unreadable /proc is an error, never
/// "no children".
fn children() -> Result<Vec<libc::pid_t>, String> {
    let tasks = std::fs::read_dir("/proc/self/task").map_err(|e| format!("cannot list the tool's processes: {e}"))?;
    let mut out = Vec::new();
    for t in tasks {
        let t = t.map_err(|e| format!("cannot list the tool's processes: {e}"))?;
        let text = std::fs::read_to_string(t.path().join("children"))
            .map_err(|e| format!("cannot list the tool's processes: {e}"))?;
        out.extend(text.split_whitespace().filter_map(|c| c.parse::<libc::pid_t>().ok()));
    }
    Ok(out)
}
