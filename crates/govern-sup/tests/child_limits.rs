//! Native end-to-end resource checks. Each subprocess has an independent wall watchdog;
//! limits are never changed in this caller, and the only fixture fork is finite.
use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

const REQUESTED: [libc::rlim_t; 3] = [2, 64 * 1024 * 1024, 32];
const RESOURCES: [libc::__rlimit_resource_t; 3] =
    [libc::RLIMIT_CPU, libc::RLIMIT_AS, libc::RLIMIT_NOFILE];

fn current_limits() -> [(libc::rlim_t, libc::rlim_t); 3] {
    RESOURCES.map(|resource| {
        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        assert_eq!(unsafe { libc::getrlimit(resource, &mut limit) }, 0);
        (limit.rlim_cur, limit.rlim_max)
    })
}

struct Fixture {
    dir: PathBuf,
    binary: PathBuf,
    policy: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let mut random = [0u8; 12];
        assert_eq!(
            unsafe { libc::getrandom(random.as_mut_ptr().cast(), random.len(), 0) },
            random.len() as isize
        );
        let name: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let dir = std::env::temp_dir().join(format!("gs-limits-{name}"));
        fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        fs::create_dir(dir.join("work")).unwrap();
        let fixture = Self {
            binary: dir.join("target"),
            policy: dir.join("policy.json"),
            dir,
        };
        // Installed compiler only: no downloads or dependencies. Static target avoids
        // dynamic-loader failure obscuring the actual low-ceiling checks.
        let mut compiler = Command::new("/usr/bin/cc");
        compiler
            .args([
                "-std=c11",
                "-D_GNU_SOURCE",
                "-O2",
                "-Wall",
                "-Wextra",
                "-Werror",
                "-static",
            ])
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/child_limits.c"))
            .arg("-o")
            .arg(&fixture.binary);
        let output = Running::spawn(&mut compiler, &fixture.dir).finish(Duration::from_secs(20));
        assert!(
            output.status.success(),
            "compiler: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        fixture.write_policy(Some(serde_json::json!({
            "cpu_seconds":REQUESTED[0], "address_space_bytes":REQUESTED[1], "open_files":REQUESTED[2],
        })));
        fixture
    }

    fn write_policy(&self, limits: Option<serde_json::Value>) {
        let mut policy = serde_json::json!({
            "version":1, "read":["/usr", "/proc", "/dev/null"],
            "write":[self.dir.join("work")], "exec":[self.binary],
            "tcp_connect":[], "cwd":self.dir.join("work"),
        });
        if let Some(limits) = limits {
            policy["child_limits"] = limits;
        }
        fs::write(&self.policy, policy.to_string()).unwrap();
    }

    fn command(&self, mode: &str) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_govern-sup"));
        command
            .args(["run", "--policy"])
            .arg(&self.policy)
            .arg("--")
            .arg(&self.binary)
            .arg(mode);
        command
    }

    fn probe(
        &self,
        mode: &str,
        inherited: [(libc::rlim_t, libc::rlim_t); 3],
        opt_in: bool,
    ) -> Command {
        let mut command = self.command(mode);
        for ((soft, hard), ceiling) in inherited.into_iter().zip(REQUESTED) {
            command.arg(if opt_in { soft.min(ceiling) } else { soft }.to_string());
            command.arg(if opt_in { hard.min(ceiling) } else { hard }.to_string());
        }
        command
    }

    fn run(&self, command: &mut Command) -> Output {
        Running::spawn(command, &self.dir).finish(Duration::from_secs(12))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

struct Running {
    child: Child,
    stdout: PathBuf,
    stderr: PathBuf,
    reaped: bool,
}
impl Running {
    fn spawn(command: &mut Command, dir: &Path) -> Self {
        let stdout = dir.join("stdout");
        let stderr = dir.join("stderr");
        command
            .stdin(Stdio::null())
            .stdout(fs::File::create(&stdout).unwrap())
            .stderr(fs::File::create(&stderr).unwrap())
            .process_group(0);
        Self {
            child: command.spawn().unwrap(),
            stdout,
            stderr,
            reaped: false,
        }
    }
    fn finish(mut self, timeout: Duration) -> Output {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                self.reaped = true;
                return Output {
                    status,
                    stdout: fs::read(&self.stdout).unwrap(),
                    stderr: fs::read(&self.stderr).unwrap(),
                };
            }
            assert!(
                Instant::now() < deadline,
                "subprocess exceeded independent wall watchdog; stderr: {}",
                fs::read_to_string(&self.stderr).unwrap()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        if !self.reaped {
            // These controlled fixtures never detach. Kill the entire test group on a
            // watchdog/panic, not just the supervisor, then reap our direct child.
            unsafe { libc::kill(-(self.child.id() as i32), libc::SIGKILL) };
            let _ = self.child.wait();
        }
    }
}

fn succeeds(output: &Output, expected: &str) {
    assert!(
        output.status.success(),
        "status {:?}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), expected);
}

#[test]
fn target_and_finite_descendant_inherit_unraisable_hard_ceilings() {
    let before = current_limits();
    let fixture = Fixture::new();
    succeeds(
        &fixture.run(&mut fixture.probe("probe", before, true)),
        "limits verified",
    );
    succeeds(
        &fixture.run(&mut fixture.probe("descendant", before, true)),
        "limits verified",
    );
    assert_eq!(current_limits(), before, "caller limits changed");
}

#[test]
fn bounded_address_space_and_fd_exhaustion_report_kernel_errors() {
    let before = current_limits();
    let fixture = Fixture::new();
    succeeds(
        &fixture.run(&mut fixture.command("address-space")),
        "ENOMEM",
    );
    succeeds(&fixture.run(&mut fixture.command("files")), "EMFILE");
    assert_eq!(current_limits(), before);
}

#[test]
fn cpu_hard_ceiling_kills_a_target_that_ignores_sigxcpu() {
    let before = current_limits();
    let fixture = Fixture::new();
    let output = fixture.run(&mut fixture.command("cpu"));
    assert_eq!(output.status.signal(), Some(libc::SIGKILL));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "SIGXCPU ignored"
    );
    assert_eq!(current_limits(), before);
}

#[test]
fn invalid_limits_never_execute_the_target() {
    let fixture = Fixture::new();
    let marker = fixture.dir.join("work/executed");
    // Prove the marker fixture really executes with a valid policy first.
    let mut command = fixture.command("marker");
    command.arg(&marker);
    assert!(fixture.run(&mut command).status.success());
    assert!(marker.exists());
    fs::remove_file(&marker).unwrap();
    for limits in [
        serde_json::Value::Null,
        serde_json::json!([2, 67108864, 32]),
        serde_json::json!({}),
        serde_json::json!({"cpu_seconds":0,"address_space_bytes":67108864,"open_files":32}),
        serde_json::json!({"cpu_seconds":1,"address_space_bytes":null,"open_files":32}),
        serde_json::json!({"cpu_seconds":1,"address_space_bytes":67108864,"open_files":32,"extra":1}),
    ] {
        fixture.write_policy(Some(limits));
        let mut command = fixture.command("marker");
        command.arg(&marker);
        let output = fixture.run(&mut command);
        assert_eq!(output.status.code(), Some(125));
        assert!(String::from_utf8_lossy(&output.stderr).contains("invalid policy"));
        assert!(!marker.exists());
    }
}

#[test]
fn lower_inherited_soft_and_hard_limits_stay_lower_in_isolated_subprocess() {
    let before = current_limits();
    let fixture = Fixture::new();
    // Only the command's pre_exec child changes limits; not this test or another test.
    let inherited = [(1, 1), (48 * 1024 * 1024, 56 * 1024 * 1024), (16, 24)];
    let mut command = fixture.probe("probe", inherited, true);
    unsafe {
        command.pre_exec(move || {
            for (resource, (soft, hard)) in RESOURCES.into_iter().zip(inherited) {
                let value = libc::rlimit {
                    rlim_cur: soft,
                    rlim_max: hard,
                };
                if libc::setrlimit(resource, &value) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    succeeds(&fixture.run(&mut command), "limits verified");
    assert_eq!(current_limits(), before);
}

#[test]
fn supervisor_limits_are_unchanged_while_restricted_child_runs() {
    let before = current_limits();
    let fixture = Fixture::new();
    let mut running = Running::spawn(&mut fixture.probe("hold", before, true), &fixture.dir);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !fs::read_to_string(&running.stdout)
        .unwrap()
        .contains("limits verified")
    {
        assert!(
            running.child.try_wait().unwrap().is_none(),
            "target failed: {}",
            fs::read_to_string(&running.stderr).unwrap()
        );
        assert!(
            Instant::now() < deadline,
            "target readiness exceeded watchdog"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let text = fs::read_to_string(format!("/proc/{}/limits", running.child.id())).unwrap();
    for (name, (soft, hard)) in ["Max cpu time", "Max address space", "Max open files"]
        .into_iter()
        .zip(before)
    {
        let line = text.lines().find(|line| line.starts_with(name)).unwrap();
        let values: Vec<_> = line[name.len()..].split_whitespace().collect();
        let show = |value: libc::rlim_t| {
            if value == libc::RLIM_INFINITY {
                "unlimited".into()
            } else {
                value.to_string()
            }
        };
        assert_eq!(values[0], show(soft));
        assert_eq!(values[1], show(hard));
    }
    unsafe { libc::kill(running.child.id() as i32, libc::SIGTERM) };
    let output = running.finish(Duration::from_secs(12));
    assert_eq!(output.status.signal(), Some(libc::SIGTERM));
    assert_eq!(current_limits(), before);
}

#[test]
fn omitted_block_preserves_inherited_limits() {
    let before = current_limits();
    let fixture = Fixture::new();
    fixture.write_policy(None);
    succeeds(
        &fixture.run(&mut fixture.probe("probe", before, false)),
        "limits verified",
    );
    assert_eq!(current_limits(), before);
}
