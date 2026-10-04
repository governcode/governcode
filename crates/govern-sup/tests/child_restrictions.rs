//! Native syscall primitive checks with controlled static targets and independent watchdogs.
//! No fixture opens external handles, contacts services, or detaches a descendant.
use std::fs;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

fn current_limits() -> [(libc::rlim_t, libc::rlim_t); 3] {
    [libc::RLIMIT_CPU, libc::RLIMIT_AS, libc::RLIMIT_NOFILE].map(|resource| {
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
        let dir = std::env::temp_dir().join(format!("gs-restrictions-{name}"));
        fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        for sub in ["work", "home", "tmp"] {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(dir.join(sub))
                .unwrap();
        }
        let fixture = Self {
            binary: dir.join("target"),
            policy: dir.join("policy.json"),
            dir,
        };
        for path in [
            fixture.dir.join("work/owned"),
            fixture.dir.join("ungranted"),
        ] {
            fs::write(&path, b"x").unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        // Installed compiler/static libc only; never fetch/install a missing toolchain.
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
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/child_restrictions.c"))
            .arg("-o")
            .arg(&fixture.binary);
        let out = Running::spawn(&mut compiler, &fixture.dir).finish(Duration::from_secs(20));
        succeeds(&out);
        fixture.write_policy(true);
        fixture
    }
    fn write_policy(&self, restricted: bool) {
        let mut policy = serde_json::json!({
            "version":1, "write":[self.dir.join("work")], "exec":[self.binary],
            "tcp_connect":[], "tcp_bind":[], "unix_connect":[], "cwd":self.dir.join("work"),
            "child_limits":{"cpu_seconds":2,"address_space_bytes":67108864,"open_files":32},
        });
        if restricted {
            policy["child_restrictions"] =
                serde_json::json!({"deny_network":true,"deny_chmod":true});
        }
        fs::write(&self.policy, policy.to_string()).unwrap();
    }
    fn command(&self, mode: &str, supervised: bool) -> Command {
        let mut command = if supervised {
            let mut c = Command::new(env!("CARGO_BIN_EXE_govern-sup"));
            c.args(["run", "--policy"])
                .arg(&self.policy)
                .arg("--")
                .arg(&self.binary);
            c
        } else {
            Command::new(&self.binary)
        };
        command
            .arg(mode)
            .arg(self.dir.join("work/owned"))
            .arg(self.dir.join("ungranted"));
        command
    }
    fn run(&self, command: &mut Command) -> Output {
        Running::spawn(command, &self.dir).finish(Duration::from_secs(15))
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
            .env_clear()
            .env("PATH", "/usr/bin")
            .env("HOME", dir.join("home"))
            .env("TMPDIR", dir.join("tmp"))
            .env("LC_ALL", "C")
            .current_dir(dir)
            .stdin(Stdio::null())
            .stdout(fs::File::create(&stdout).unwrap())
            .stderr(fs::File::create(&stderr).unwrap())
            .process_group(0);
        Self {
            child: command
                .spawn()
                .expect("installed compiler/fixture must be available; no installation attempted"),
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
                "independent wall watchdog expired: {}",
                fs::read_to_string(&self.stderr).unwrap()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        if !self.reaped {
            // Controlled finite fixtures never detach. This cleanup is not production
            // hard-kill containment and makes no claim about arbitrary agent descendants.
            unsafe { libc::kill(-(self.child.id() as i32), libc::SIGKILL) };
            let _ = self.child.wait();
        }
    }
}
fn succeeds(out: &Output) {
    assert!(
        out.status.success(),
        "status {:?}; stdout: {}; stderr: {}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn native_controls_and_restricted_syscalls_file_io_and_fork_exec() {
    let before = current_limits();
    let fixture = Fixture::new();
    let controls = fixture.run(&mut fixture.command("control", false));
    succeeds(&controls);
    // Keep modern positive-control skips visible in acceptance logs on older kernels.
    eprintln!(
        "native controls: {}",
        String::from_utf8_lossy(&controls.stdout)
    );
    let out = fixture.run(&mut fixture.command("restricted", true));
    succeeds(&out);
    assert!(
        String::from_utf8_lossy(&out.stdout)
            .contains("restrictions inherited through finite fork/exec")
    );
    for path in [
        fixture.dir.join("work/owned"),
        fixture.dir.join("ungranted"),
    ] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o7777,
            0o600
        );
    }
    assert_eq!(current_limits(), before);
}

#[test]
fn absent_restrictions_preserve_native_chmod_and_socket_creation() {
    let fixture = Fixture::new();
    fixture.write_policy(false);
    // Grant both owned files for this default-behavior control only.
    let mut policy: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&fixture.policy).unwrap()).unwrap();
    policy["write"] = serde_json::json!([fixture.dir.join("work"), fixture.dir.join("ungranted")]);
    fs::write(&fixture.policy, policy.to_string()).unwrap();
    // Preserve the historical Unix denials below ABI 9. Choosing this branch is
    // not evidence of a live old-kernel run on a newer host.
    let abi = unsafe { libc::syscall(libc::SYS_landlock_create_ruleset, 0, 0, 1) };
    let mode = if abi < 9 {
        "default-old-abi"
    } else {
        "control"
    };
    succeeds(&fixture.run(&mut fixture.command(mode, true)));
}

#[test]
fn resource_exhaustion_coexists_and_parent_limits_stay_unchanged() {
    let before = current_limits();
    let fixture = Fixture::new();
    for (mode, expected) in [("files", "EMFILE"), ("address-space", "ENOMEM")] {
        let out = fixture.run(&mut fixture.command(mode, true));
        succeeds(&out);
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), expected);
    }
    let out = fixture.run(&mut fixture.command("cpu", true));
    assert_eq!(out.status.signal(), Some(libc::SIGKILL));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "SIGXCPU ignored"
    );
    assert_eq!(current_limits(), before);
}

#[test]
fn invalid_policies_and_seccomp_installation_failure_never_execute_target() {
    let fixture = Fixture::new();
    let marker = fixture.dir.join("work/marker");
    let marker_command = || {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_govern-sup"));
        cmd.args(["run", "--policy"])
            .arg(&fixture.policy)
            .arg("--")
            .arg(&fixture.binary)
            .arg("marker")
            .arg(&marker)
            .arg(fixture.dir.join("ungranted"));
        cmd
    };
    succeeds(&fixture.run(&mut marker_command()));
    assert!(marker.exists());
    fs::remove_file(&marker).unwrap();
    let valid = fs::read_to_string(&fixture.policy).unwrap();
    let original: serde_json::Value = serde_json::from_str(&valid).unwrap();
    for value in [
        serde_json::Value::Null,
        serde_json::json!([true, true]),
        serde_json::json!({}),
        serde_json::json!({"deny_network":true,"deny_chmod":false}),
    ] {
        let mut policy = original.clone();
        policy["child_restrictions"] = value;
        fs::write(&fixture.policy, policy.to_string()).unwrap();
        let out = fixture.run(&mut marker_command());
        assert_eq!(out.status.code(), Some(125));
        assert!(!marker.exists());
    }
    for key in ["tcp_connect", "tcp_bind", "unix_connect"] {
        let mut policy = original.clone();
        policy[key] = if key == "unix_connect" {
            serde_json::json!([fixture.dir.join("missing.sock")])
        } else {
            serde_json::json!([443])
        };
        fs::write(&fixture.policy, policy.to_string()).unwrap();
        let out = fixture.run(&mut marker_command());
        assert_eq!(out.status.code(), Some(125));
        assert!(String::from_utf8_lossy(&out.stderr).contains(&format!("requires empty {key}")));
        assert!(!marker.exists());
    }
    fs::write(&fixture.policy, valid).unwrap();
    let mut command = marker_command();
    // Test-only outer filter denies the child's filter installation, with no
    // production environment switch or injection hook. Parent remains untouched.
    unsafe {
        command.pre_exec(|| {
            let filter = [
                libc::sock_filter {
                    code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16,
                    jt: 0,
                    jf: 0,
                    k: 0,
                },
                libc::sock_filter {
                    code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
                    jt: 0,
                    jf: 3,
                    k: libc::SYS_prctl as u32,
                },
                libc::sock_filter {
                    code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16,
                    jt: 0,
                    jf: 0,
                    k: 16,
                },
                libc::sock_filter {
                    code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
                    jt: 0,
                    jf: 1,
                    k: libc::PR_SET_SECCOMP as u32,
                },
                libc::sock_filter {
                    code: (libc::BPF_RET | libc::BPF_K) as u16,
                    jt: 0,
                    jf: 0,
                    k: libc::SECCOMP_RET_ERRNO | libc::EPERM as u32,
                },
                libc::sock_filter {
                    code: (libc::BPF_RET | libc::BPF_K) as u16,
                    jt: 0,
                    jf: 0,
                    k: libc::SECCOMP_RET_ALLOW,
                },
            ];
            let program = libc::sock_fprog {
                len: filter.len() as u16,
                filter: filter.as_ptr() as *mut _,
            };
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
                || libc::prctl(
                    libc::PR_SET_SECCOMP,
                    libc::SECCOMP_MODE_FILTER,
                    &program as *const _,
                ) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let out = fixture.run(&mut command);
    assert_eq!(out.status.code(), Some(125));
    assert!(String::from_utf8_lossy(&out.stderr).contains("cannot enforce the seccomp rules"));
    assert!(!marker.exists());
}

#[test]
fn supervisor_limits_stay_unchanged_while_restricted_target_runs() {
    let before = current_limits();
    let fixture = Fixture::new();
    let mut running = Running::spawn(&mut fixture.command("hold", true), &fixture.dir);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !fs::read_to_string(&running.stdout)
        .unwrap()
        .contains("ceilings verified")
    {
        assert!(
            running.child.try_wait().unwrap().is_none(),
            "target failed: {}",
            fs::read_to_string(&running.stderr).unwrap()
        );
        assert!(
            Instant::now() < deadline,
            "target readiness watchdog expired"
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
    let out = running.finish(Duration::from_secs(12));
    assert_eq!(out.status.signal(), Some(libc::SIGTERM));
    assert_eq!(current_limits(), before);
}
