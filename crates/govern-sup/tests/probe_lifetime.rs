//! Explicit feature-only native integration fixtures. Every launch has an outer
//! watchdog as well as the native pidfd guard. Unsupported creation is reported
//! as a skip of live cases, never successful namespace acceptance.
#[path = "../src/probe_lifetime.rs"]
#[allow(dead_code)]
mod probe_lifetime;
use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Running {
    child: Child,
    finished: bool,
}
impl Running {
    fn wait(&mut self, timeout: Duration) -> std::process::ExitStatus {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().unwrap() {
                self.finished = true;
                return status;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("independent fixture watchdog expired; contents retained");
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.child.kill();
            // No indefinite parent wait after deadline. The native verifier has
            // PDEATHSIG and its own bounded deadline; targets have finite fallbacks.
            let deadline = Instant::now() + Duration::from_secs(1);
            while Instant::now() < deadline {
                if self.child.try_wait().ok().flatten().is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
}
struct Fixture {
    dir: PathBuf,
    binary: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let mut random = [0u8; 12];
        assert_eq!(
            unsafe { libc::getrandom(random.as_mut_ptr().cast(), random.len(), 0) },
            random.len() as isize
        );
        let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let dir = std::env::temp_dir().join(format!("gs-lifetime-{suffix}"));
        fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        fs::create_dir(dir.join("home")).unwrap();
        fs::create_dir(dir.join("tmp")).unwrap();
        let binary = dir.join("target");
        let out = fs::File::create(dir.join("cc-out")).unwrap();
        let err = fs::File::create(dir.join("cc-err")).unwrap();
        let child = Command::new("/usr/bin/cc")
            .args([
                "-std=c11",
                "-D_GNU_SOURCE",
                "-O2",
                "-Wall",
                "-Wextra",
                "-Werror",
                "-static",
            ])
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/probe_lifetime.c"))
            .arg("-o")
            .arg(&binary)
            .env_clear()
            .env("PATH", "/usr/bin")
            .env("HOME", dir.join("home"))
            .env("TMPDIR", dir.join("tmp"))
            .stdin(Stdio::null())
            .stdout(out)
            .stderr(err)
            .spawn()
            .unwrap();
        let status = Running {
            child,
            finished: false,
        }
        .wait(Duration::from_secs(20));
        assert!(status.success(), "installed static compiler failed");
        Self { dir, binary }
    }
    fn run(&self, mode: &str) -> (i32, String, PathBuf) {
        let dir = self.dir.join(mode);
        fs::create_dir(&dir).unwrap();
        fs::create_dir(dir.join("work")).unwrap();
        let policy = serde_json::json!({"version":1, "read":[], "write":[dir.join("work")],
            "exec":[self.binary], "tcp_connect":[], "cwd":dir.join("work"),
            "child_restrictions":{"deny_network":true,"deny_chmod":true}});
        fs::write(dir.join("policy.json"), policy.to_string()).unwrap();
        let stdout = fs::File::create(dir.join("driver-out")).unwrap();
        let stderr = fs::File::create(dir.join("driver-err")).unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_probe-lifetime-driver"))
            .arg(mode)
            .arg(&dir)
            .arg(&self.binary)
            .arg(dir.join("policy.json"))
            .env_clear()
            .env("PATH", "/usr/bin")
            .env("HOME", self.dir.join("home"))
            .env("TMPDIR", self.dir.join("tmp"))
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .spawn()
            .unwrap();
        let status = Running {
            child,
            finished: false,
        }
        .wait(Duration::from_secs(12));
        let output = fs::read_to_string(dir.join("driver-out")).unwrap();
        let error = fs::read_to_string(dir.join("driver-err")).unwrap();
        assert!(
            matches!(status.code(), Some(0 | 77 | 78)),
            "driver failure in {mode}: {error}"
        );
        if status.code() == Some(77) {
            eprintln!("{mode}: {}", error.trim());
        }
        (status.code().unwrap(), output, dir)
    }
}

#[test]
fn finite_owned_namespace_matrix() {
    let f = Fixture::new();
    // Actual creation, never kernel config/sysctl or a simulated positive result.
    let (code, output, dir) = f.run("normal");
    if code == 77 {
        assert!(output.contains("UNAVAILABLE zero-admission"));
        assert!(!dir.join("work/executed").exists());
        eprintln!(
            "SKIP live namespace matrix: actual clone3/pidfd creation unavailable; zero target admission (see native facility errno). Logical validation remains tested."
        );
        // No namespace was created; finite compiler/driver files are owned and inert.
        fs::remove_dir_all(&f.dir).unwrap();
        return;
    }
    assert_eq!(output.trim(), "PROVEN 7");
    assert!(dir.join("work/executed").exists());
    let cases = [
        ("high-exit", "PROVEN H"),
        ("signal", "PROVEN S"),
        ("signal-tree", "PROVEN S"),
        ("cpu", "PROVEN K"),
        ("direct", "PROVEN 0"),
        ("double", "PROVEN 0"),
        ("nested", "PROVEN 7"),
        ("init-kill", "PROVEN K"),
        ("cancel", "PROVEN C"),
        ("output-failure", "PROVEN C"),
        ("control-eof", "PROVEN C"),
        ("control-error", "PROVEN C"),
        ("deadline", "PROVEN C"),
        ("pre-cancel", "PROVEN F"),
        ("map-failure", "PROVEN F"),
        ("restrict-failure", "PROVEN F"),
        ("exec-failure", "PROVEN F"),
        ("forge", "PROVEN 0"),
        ("sandbox", "PROVEN 0"),
        (
            "death-before-registration",
            "GUARD-REAP verifier-proof-lost",
        ),
        ("death-registration", "GUARD-REAP verifier-proof-lost"),
        ("death-mapping", "GUARD-REAP verifier-proof-lost"),
        ("death-gate", "GUARD-REAP verifier-proof-lost"),
        ("death-admitted", "GUARD-REAP verifier-proof-lost"),
    ];
    for (mode, expected) in cases {
        let (code, output, dir) = f.run(mode);
        assert_eq!(code, 0, "{mode}");
        assert_eq!(output.trim(), expected, "{mode}");
        if [
            "guard-eof",
            "pre-cancel",
            "death-before-registration",
            "map-failure",
            "restrict-failure",
            "exec-failure",
            "death-registration",
            "death-mapping",
            "death-gate",
        ]
        .contains(&mode)
        {
            assert!(
                !dir.join("work/executed").exists(),
                "setup/death gate admitted target: {mode}"
            );
        }
        if [
            "direct",
            "double",
            "signal-tree",
            "init-kill",
            "cancel",
            "output-failure",
            "control-eof",
            "death-admitted",
        ]
        .contains(&mode)
        {
            assert!(
                dir.join("work/descendant-ready").exists(),
                "descendant actually exercised: {mode}"
            );
            assert!(
                !dir.join("work/late-activity").exists(),
                "late activity: {mode}"
            );
        }
        if mode == "forge" {
            assert!(dir.join("work/forge-rejected").exists());
        }
        if mode == "sandbox" {
            assert!(dir.join("work/sandbox-ok").exists());
        }
        // Exact native/guard proof exists before removing this finite fixture case.
        fs::remove_dir_all(dir).unwrap();
    }
    for mode in ["clone-failure", "pidfd-failure"] {
        let (code, output, dir) = f.run(mode);
        assert_eq!(code, 77);
        assert!(output.contains("zero-admission"));
        assert!(!dir.join("work/executed").exists());
        fs::remove_dir_all(dir).unwrap();
    }
    for mode in [
        "wait-failure",
        "withhold",
        "guard-eof",
        "watchdog",
        "proof-truncate",
    ] {
        let (code, output, dir) = f.run(mode);
        assert_eq!(code, 78);
        assert_eq!(output.trim(), "UNPROVEN retain");
        assert!(!dir.join("work/late-activity").exists());
        // Deliberately retain: independently reaping for fixture safety does not
        // convert the verifier's missing proof into cleanup authorization.
    }
    eprintln!(
        "live namespace cases passed; intentionally retained five unproven finite fixture directories"
    );
}

#[test]
fn unsupported_injections_admit_no_targets() {
    let f = Fixture::new();
    for mode in ["clone-failure", "pidfd-failure"] {
        let (code, output, dir) = f.run(mode);
        assert_eq!(code, 77);
        assert_eq!(output.trim(), "UNAVAILABLE zero-admission");
        assert!(!dir.join("work/executed").exists());
    }
    fs::remove_dir_all(f.dir).unwrap();
}
