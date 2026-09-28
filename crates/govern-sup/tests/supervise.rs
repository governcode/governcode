//! The supervisor end to end: a real `govern-sup run` with a small policy.
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn policy(dir: &std::path::Path) -> std::path::PathBuf {
    let p = dir.join("policy.json");
    let work = dir.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let json = format!(
        r#"{{"version":1,"read":["/usr","/etc","/proc","/dev/urandom"],"write":["{w}","/dev/null"],"exec":["/usr/bin","/usr/lib"],"tcp_connect":[],"cwd":"{w}"}}"#,
        w = work.display()
    );
    std::fs::write(&p, json).unwrap();
    p
}

fn tmp(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("gs-it-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn sup(p: &std::path::Path, script: &str) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_govern-sup"));
    c.args(["run", "--policy"]).arg(p).args(["--", "/usr/bin/sh", "-c", script]).stdin(Stdio::null());
    c
}

#[test]
fn exit_codes_and_signals_pass_through() {
    use std::os::unix::process::ExitStatusExt;
    let d = tmp("exit");
    let p = policy(&d);
    assert_eq!(sup(&p, "exit 7").status().unwrap().code(), Some(7));
    // A tool killed by a signal: the supervisor ends the same way.
    assert_eq!(sup(&p, "kill -KILL $$").status().unwrap().signal(), Some(libc::SIGKILL));
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn a_tool_that_ignores_sigterm_is_killed_after_the_grace_period() {
    use std::os::unix::process::ExitStatusExt;
    let d = tmp("term");
    let p = policy(&d);
    let mut child = sup(&p, "trap '' TERM; sleep 60 & sleep 60; wait").spawn().unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let t = Instant::now();
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    let st = child.wait().unwrap();
    assert!(t.elapsed() < Duration::from_secs(8), "took {:?}", t.elapsed());
    assert_eq!(st.signal(), Some(libc::SIGTERM));
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn nothing_the_tool_started_survives_it() {
    let d = tmp("orphans");
    let p = policy(&d);
    let marker = d.join("work/late.txt");
    // A detached grandchild (new session) that writes a file after the tool has exited.
    let script = format!("setsid sh -c 'sleep 1; echo x > {}' </dev/null >/dev/null 2>&1 & exit 0", marker.display());
    assert_eq!(sup(&p, &script).status().unwrap().code(), Some(0));
    std::thread::sleep(Duration::from_millis(1600));
    assert!(!marker.exists(), "a process outlived the run");
    let _ = std::fs::remove_dir_all(&d);
}
