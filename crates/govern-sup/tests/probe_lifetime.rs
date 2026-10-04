//! Explicit feature-only native integration fixtures. Every launch has an outer
//! watchdog as well as the native pidfd guard. Unsupported creation is reported
//! as a skip of live cases, never successful namespace acceptance.
#[path = "../src/limits.rs"]
#[allow(dead_code)]
mod limits;
#[path = "../src/policy.rs"]
#[allow(dead_code)]
mod policy;
#[path = "../src/probe_artifact.rs"]
#[allow(dead_code)]
mod probe_artifact;
#[path = "../src/probe_context.rs"]
#[allow(dead_code)]
mod probe_context;
#[path = "../src/probe_lifetime.rs"]
#[allow(dead_code)]
mod probe_lifetime;
#[path = "../src/sandbox.rs"]
#[allow(dead_code)]
mod sandbox;
#[path = "../src/supervise.rs"]
#[allow(dead_code)]
mod supervise;
use std::fs;
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
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
    fn new() -> Option<Self> {
        // Legacy pathname cases compile their own target and do not require
        // the bound A/B assets or their x86_64 image-layout checks.
        if !Path::new("/usr/bin/cc").is_file() {
            eprintln!(
                "SKIP live legacy native fixture: installed compiler unavailable; zero target launches"
            );
            return None;
        }
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
        let child = match Command::new("/usr/bin/cc")
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
        {
            Ok(child) => child,
            Err(_) => {
                eprintln!(
                    "SKIP live native fixture: static compiler unavailable; zero targets; retained {}",
                    dir.display()
                );
                return None;
            }
        };
        let mut compiler = Running {
            child,
            finished: false,
        };
        let deadline = Instant::now() + Duration::from_secs(20);
        let compiled = loop {
            match compiler.child.try_wait() {
                Ok(Some(status)) => {
                    compiler.finished = true;
                    break status.success();
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                _ => break false,
            }
        };
        // Running's bounded drop stops/reaps a timed-out compiler; the legacy
        // availability check must not panic through the target launch watchdog.
        drop(compiler);
        if !compiled {
            eprintln!(
                "SKIP live legacy native fixture: static compilation failed or exceeded watchdog; zero targets; retained {}",
                dir.display()
            );
            return None;
        }
        Some(Self { dir, binary })
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
    let Some(f) = Fixture::new() else {
        return;
    };
    // Actual creation, never kernel config/sysctl or a simulated positive result.
    let (code, output, dir) = f.run("normal");
    if code == 77 {
        assert!(output.contains("UNAVAILABLE zero-admission"));
        assert!(!dir.join("work/executed").exists());
        eprintln!(
            "SKIP live namespace matrix: actual clone3/pidfd creation unavailable; zero target admission (see native facility errno). Logical validation remains tested."
        );
        // No namespace was created; finite compiler/driver files are owned and inert.
        remove_legacy_case(&dir);
        remove_transport_fixture(&f);
        return;
    }
    assert_eq!(output.trim(), "PROVEN 7");
    assert!(dir.join("work/executed").exists());
    remove_legacy_case(&dir);
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
        // Independent guard safety after verifier death is not removal authority.
        if !mode.starts_with("death-") {
            remove_legacy_case(&dir);
        }
    }
    for mode in ["clone-failure", "pidfd-failure"] {
        let (code, output, dir) = f.run(mode);
        assert_eq!(code, 77);
        assert!(output.contains("zero-admission"));
        assert!(!dir.join("work/executed").exists());
        remove_legacy_case(&dir);
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
        "live namespace cases passed; intentionally retained ten unproven finite fixture directories"
    );
}

#[test]
fn unsupported_injections_admit_no_targets() {
    let Some(f) = Fixture::new() else {
        return;
    };
    for mode in ["clone-failure", "pidfd-failure"] {
        let (code, output, dir) = f.run(mode);
        assert_eq!(code, 77);
        assert_eq!(output.trim(), "UNAVAILABLE zero-admission");
        assert!(!dir.join("work/executed").exists());
        remove_legacy_case(&dir);
    }
    remove_transport_fixture(&f);
}

// Transport checks use the same pipe/Unix-stream endpoint types as the Node
// fixture owner. No file, /dev/null, reopened /dev/fd, or target-supplied channel
// substitutes for one of the five fresh driver endpoints.
const INVOCATION: [u8; 16] = [0x4a; 16];
const INVOCATION_HEX: &str = "4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a";

#[derive(Clone, Copy)]
enum TransportAction {
    None,
    StopData,
    StopRepeated,
    StopEof,
    StopError,
    StopWriteFailure,
    InvalidLayout,
    Acp,
    Forbidden,
    Hung,
    OutputBudget,
    CloseProof,
}
struct TransportRun {
    code: i32,
    proof: Vec<u8>,
    proof_bytes: usize,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    proof_ended: bool,
    elapsed: Duration,
    stop_requested: Option<Instant>,
    joined: Instant,
    dir: PathBuf,
}
fn nonblocking(fd: i32) {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    assert!(flags >= 0);
    assert_eq!(
        unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) },
        0
    );
}
fn drain(reader: &mut impl Read, bytes: &mut Vec<u8>, total: &mut usize, cap: usize) -> bool {
    let mut buffer = [0u8; 4096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return true,
            Ok(n) => {
                *total += n;
                let keep = n.min(cap.saturating_sub(bytes.len()));
                bytes.extend_from_slice(&buffer[..keep]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return false,
            Err(error) => panic!("fixture endpoint failed: {error}; contents retained"),
        }
    }
}
impl Fixture {
    fn transport(&self, scenario: &str, label: &str, action: TransportAction) -> TransportRun {
        self.transport_config(scenario, label, action, false, |_| {})
    }
    fn bound_transport(
        &self,
        scenario: &str,
        label: &str,
        action: TransportAction,
    ) -> TransportRun {
        self.transport_config(scenario, label, action, true, |_| {})
    }
    fn transport_config(
        &self,
        scenario: &str,
        label: &str,
        action: TransportAction,
        bound: bool,
        mutate: impl FnOnce(&Path),
    ) -> TransportRun {
        let dir = self.dir.join(format!("transport-{label}"));
        fs::create_dir(&dir).unwrap();
        fs::create_dir(dir.join("work")).unwrap();
        let target = if bound {
            let target = dir.join("artifact");
            fs::write(&target, probe_artifact::EMBEDDED_A).unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();
            mutate(&target);
            target
        } else {
            self.binary.clone()
        };
        let executable = if bound { vec![] } else { vec![target.clone()] };
        let policy = serde_json::json!({"version":1,"read":[],"write":[dir.join("work")],
            "exec":executable,"tcp_connect":[],"cwd":dir.join("work"),
            "child_restrictions":{"deny_network":true,"deny_chmod":true}});
        fs::write(dir.join("policy.json"), policy.to_string()).unwrap();
        self.transport_prepared(scenario, action, dir, target, bound, None)
    }
    fn transport_prepared(
        &self,
        scenario: &str,
        action: TransportAction,
        dir: PathBuf,
        target: PathBuf,
        bound: bool,
        context: Option<&ContextCase>,
    ) -> TransportRun {
        let marker_dir = context.map_or_else(|| dir.join("work"), |c| c.root.join("cwd"));
        let (control, control_peer) = UnixStream::pair().unwrap();
        let (proof, proof_peer) = UnixStream::pair().unwrap();
        // Duplicate above 4 before pre_exec so dup2 cannot clobber either source.
        let duplicate = |fd: i32| {
            let fd = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 5) };
            assert!(fd >= 5);
            unsafe { OwnedFd::from_raw_fd(fd) }
        };
        let child_control = duplicate(control_peer.as_raw_fd());
        let child_proof = duplicate(proof_peer.as_raw_fd());
        drop(control_peer);
        drop(proof_peer);
        let mut command = Command::new(env!("CARGO_BIN_EXE_probe-lifetime-driver"));
        command
            .arg(if context.is_some() {
                "context-bound-transport-v1"
            } else if bound {
                "bound-transport-v1"
            } else {
                "transport-v1"
            })
            .arg(&target)
            .arg(scenario)
            .arg(dir.join("work"));
        if let Some(context) = context {
            command
                .arg(&context.root)
                .args(&context.identities)
                .arg(&context.invocation_hex);
        } else {
            command.arg(dir.join("policy.json")).arg(INVOCATION_HEX);
        }
        command
            .env_clear()
            .env("PATH", "/usr/bin")
            .env("HOME", dir.join("work"))
            .env("TMPDIR", dir.join("work"))
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(context) = context {
            command.current_dir(dir.join("work"));
            if context.poisoned {
                // Every ambient selector is deliberately wrong. Contextual exec
                // must use its own fourteen-field storage and omit extra fields.
                for name in [
                    "HOME",
                    "XDG_CONFIG_HOME",
                    "XDG_CACHE_HOME",
                    "XDG_DATA_HOME",
                    "XDG_STATE_HOME",
                    "XDG_RUNTIME_DIR",
                    "XDG_CONFIG_DIRS",
                    "XDG_DATA_DIRS",
                    "TMPDIR",
                    "TMP",
                    "TEMP",
                    "PATH",
                    "LANG",
                    "LC_ALL",
                ] {
                    command.env(name, "/ambient-ungranted-fixture");
                }
                command.env("CONTEXT_AMBIENT_POISON", "must-not-reach-A");
            }
        }
        unsafe {
            command.pre_exec(move || {
                for (source, destination) in
                    [(child_control.as_raw_fd(), 3), (child_proof.as_raw_fd(), 4)]
                {
                    if libc::dup2(source, destination) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                // The five-entry contract permits no inherited aliases. Close
                // source duplicates and every other child-side descriptor,
                // including aliases created by the standard spawn machinery.
                if libc::syscall(libc::SYS_close_range, 5u32, u32::MAX, 0u32) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if matches!(action, TransportAction::InvalidLayout) && libc::dup2(4, 10) != 10 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let started = Instant::now();
        let mut running = Running {
            child: command.spawn().unwrap(),
            finished: false,
        };
        drop(command); // Close the deliberately created child-side aliases in the parent.
        let mut stdin = running.child.stdin.take().unwrap();
        let mut stdout = running.child.stdout.take().unwrap();
        let mut stderr = running.child.stderr.take().unwrap();
        for fd in [
            stdin.as_raw_fd(),
            stdout.as_raw_fd(),
            stderr.as_raw_fd(),
            control.as_raw_fd(),
            proof.as_raw_fd(),
        ] {
            nonblocking(fd);
        }
        let mut control = Some(control);
        let mut proof = Some(proof);
        let mut proof_eof = false;
        if matches!(action, TransportAction::CloseProof) {
            drop(proof.take());
            proof_eof = true;
        }
        let requests = match action {
            TransportAction::Acp | TransportAction::Hung =>
                b"{\"id\":1,\"method\":\"initialize\",\"params\":{}}\n{\"id\":2,\"method\":\"session/new\",\"params\":{}}\n".as_slice(),
            TransportAction::Forbidden =>
                b"{\"id\":1,\"method\":\"initialize\",\"params\":{}}\n{\"id\":2,\"method\":\"session/new\",\"params\":{}}\n{\"id\":100,\"error\":{\"code\":-32601,\"message\":\"fixture refusal\"}}\n".as_slice(),
            _ => b"".as_slice(),
        };
        let mut request_offset = 0;
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut record = Vec::new();
        let (mut out_bytes, mut err_bytes, mut proof_bytes) = (0, 0, 0);
        let (mut out_eof, mut err_eof) = (false, false);
        let mut status = None;
        let mut stop_requested = None;
        let deadline = Instant::now() + Duration::from_secs(13);
        loop {
            assert!(
                Instant::now() < deadline,
                "independent transport watchdog expired in {scenario}; contents retained"
            );
            if request_offset < requests.len() {
                match stdin.write(&requests[request_offset..]) {
                    Ok(n) => request_offset += n,
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock
                                | std::io::ErrorKind::Interrupted
                                | std::io::ErrorKind::BrokenPipe
                        ) => {}
                    Err(error) => panic!("fixture stdin failed: {error}"),
                }
            }
            if !out_eof {
                out_eof = drain(&mut stdout, &mut out, &mut out_bytes, 300_000);
            }
            if !err_eof {
                err_eof = drain(&mut stderr, &mut err, &mut err_bytes, 300_000);
            }
            if !proof_eof {
                proof_eof = drain(proof.as_mut().unwrap(), &mut record, &mut proof_bytes, 64);
            }
            let ready = match action {
                TransportAction::StopData
                | TransportAction::StopRepeated
                | TransportAction::StopEof
                | TransportAction::StopError
                | TransportAction::StopWriteFailure => marker_dir.join("descendant-ready").exists(),
                TransportAction::Hung => marker_dir.join("hung-request").exists(),
                TransportAction::OutputBudget => out_bytes + err_bytes > 65_536,
                _ => false,
            };
            if ready && let Some(mut endpoint) = control.take() {
                // Start the stop budget at the first actual request/action,
                // before write/shutdown/EOF. Repeated writes and failed-write
                // EOF fallback must never restart it; readiness is not proof.
                stop_requested.get_or_insert_with(Instant::now);
                match action {
                    TransportAction::StopData | TransportAction::StopRepeated => {
                        let _ = endpoint.write(b"stop");
                        if matches!(action, TransportAction::StopRepeated) {
                            let _ = endpoint.write(b"stop-again");
                        }
                    }
                    TransportAction::StopError => {
                        endpoint.shutdown(Shutdown::Both).unwrap();
                    }
                    TransportAction::StopWriteFailure => {
                        endpoint.shutdown(Shutdown::Write).unwrap();
                        assert!(
                            endpoint.write(b"stop").is_err(),
                            "actual stop write must fail"
                        );
                    }
                    _ => {}
                }
                drop(endpoint); // EOF is also the bounded fallback for a failed stop write.
            }
            if status.is_none()
                && let Some(done) = running.child.try_wait().unwrap()
            {
                running.finished = true;
                status = Some(done);
            }
            if status.is_some() && proof_eof && out_eof && err_eof {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        let joined = Instant::now();
        TransportRun {
            code: status
                .unwrap()
                .code()
                .expect("outer guard must classify its exact verifier exit"),
            proof: record,
            proof_bytes,
            stdout: out,
            stderr: err,
            proof_ended: proof_eof && !matches!(action, TransportAction::CloseProof),
            elapsed: joined.duration_since(started),
            stop_requested,
            joined,
            dir,
        }
    }
}
fn frame(kind: u8, detail: u8, value: u32) -> [u8; 32] {
    let mut bytes = [0; 32];
    bytes[..8].copy_from_slice(&[b'G', b'P', b'L', b'T', 1, kind, detail, 0]);
    bytes[8..24].copy_from_slice(&INVOCATION);
    bytes[24..28].copy_from_slice(&value.to_be_bytes());
    bytes
}
fn exact_record(run: &TransportRun, expected: [u8; 32]) {
    assert!(run.proof_ended, "owned proof END was not observed");
    assert_eq!(
        run.proof_bytes,
        32,
        "{}: {:?}",
        run.dir.display(),
        run.stderr
    );
    assert_eq!(run.proof, expected);
}
fn no_execution(run: &TransportRun) {
    assert!(
        !run.dir.join("work/executed").exists(),
        "refusal admitted a target"
    );
    assert!(!run.dir.join("work/pre-restriction-fds").exists());
}

// Remove only this finite owner's known files after the strict join (or checked
// zero-execution refusal). Unexpected contents stop cleanup and remain retained.
fn remove_transport_files(dir: &Path) {
    for name in [
        "executed",
        "descendant-ready",
        "late-activity",
        "forge-rejected",
        "sandbox-ok",
        "fd-closed",
        "acp-ready",
        "forbidden-rejected",
        "pre-restriction-fds",
        "hung-request",
        "flood-ready",
        "image-a-executed",
        "image-b-executed",
        "sealed-aliases-ok",
    ] {
        match fs::remove_file(dir.join("work").join(name)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("finite fixture cleanup failed: {error}; contents retained"),
        }
    }
    fs::remove_dir(dir.join("work")).unwrap();
    fs::remove_file(dir.join("policy.json")).unwrap();
    for name in ["artifact", "artifact-other", "artifact-link"] {
        match fs::remove_file(dir.join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => panic!("finite source cleanup failed: {e}; retained"),
        }
    }
    fs::remove_dir(dir).unwrap();
}
fn remove_legacy_case(dir: &Path) {
    for name in [
        "executed",
        "descendant-ready",
        "late-activity",
        "forge-rejected",
        "sandbox-ok",
        "nested-ready",
    ] {
        match fs::remove_file(dir.join("work").join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => panic!("finite legacy cleanup failed: {e}; retained"),
        }
    }
    fs::remove_dir(dir.join("work")).unwrap();
    for name in [
        "policy.json",
        "driver-out",
        "driver-err",
        "target-out",
        "target-err",
    ] {
        fs::remove_file(dir.join(name)).unwrap();
    }
    fs::remove_dir(dir).unwrap();
}
fn remove_transport_fixture(fixture: &Fixture) {
    for name in ["target", "cc-out", "cc-err"] {
        fs::remove_file(fixture.dir.join(name)).unwrap();
    }
    for name in ["home", "tmp"] {
        fs::remove_dir(fixture.dir.join(name)).unwrap();
    }
    fs::remove_dir(&fixture.dir).unwrap();
}

#[test]
fn transport_stream_namespace_matrix() {
    let Some(fixture) = Fixture::new() else {
        return;
    };
    let normal = fixture.transport("normal", "normal", TransportAction::None);
    if normal.code == 65 {
        exact_record(&normal, frame(2, 2, 0));
        no_execution(&normal);
        eprintln!(
            "SKIP transport namespace matrix: native namespace/pidfd facilities unavailable; exact unsupported record and zero executed marker checked"
        );
        remove_transport_files(&normal.dir);
        remove_transport_fixture(&fixture);
        return;
    }
    assert_eq!(normal.code, 0);
    exact_record(&normal, frame(1, 1, 7));
    assert!(normal.dir.join("work/executed").exists());
    assert!(normal.dir.join("work/pre-restriction-fds").exists());
    remove_transport_files(&normal.dir);
    let cases = [
        ("high-exit", TransportAction::None, 1, 200),
        ("signal", TransportAction::None, 2, libc::SIGTERM as u32),
        ("direct", TransportAction::None, 1, 0),
        ("double", TransportAction::None, 1, 0),
        ("detach", TransportAction::None, 1, 0),
        (
            "signal-tree",
            TransportAction::None,
            2,
            libc::SIGTERM as u32,
        ),
        ("kill-init", TransportAction::None, 2, libc::SIGKILL as u32),
        ("hold", TransportAction::StopData, 3, 0),
        ("hold", TransportAction::StopEof, 3, 0),
        ("hold", TransportAction::StopError, 3, 0),
        ("hold", TransportAction::StopWriteFailure, 3, 0),
        ("guard-registration-deadline", TransportAction::None, 4, 0),
        ("control-error", TransportAction::None, 3, 0),
        ("forge", TransportAction::None, 1, 0),
        ("acp", TransportAction::Acp, 1, 0),
        ("acp-forbidden", TransportAction::Forbidden, 1, 0),
        ("acp-hang", TransportAction::Hung, 3, 0),
        ("stdout-flood", TransportAction::OutputBudget, 0, 0),
        ("stderr-flood", TransportAction::OutputBudget, 0, 0),
        ("map-failure", TransportAction::None, 4, 0),
        ("restrict-failure", TransportAction::None, 4, 0),
        ("exec-failure", TransportAction::None, 4, 0),
    ];
    for (index, (scenario, action, detail, value)) in cases.iter().enumerate() {
        let run = fixture.transport(scenario, &format!("{index}-{scenario}"), *action);
        assert_eq!(run.code, 0, "{scenario}: {:?}", run.stderr);
        if *detail == 0 {
            // Flood can exit before stop or observe the owner's stop.
            assert!(run.proof == frame(1, 1, 0) || run.proof == frame(1, 3, 0));
            assert_eq!(run.proof_bytes, 32);
        } else {
            exact_record(&run, frame(1, *detail, *value));
        }
        if [
            "direct",
            "double",
            "detach",
            "signal-tree",
            "kill-init",
            "hold",
        ]
        .contains(scenario)
        {
            assert!(
                run.dir.join("work/descendant-ready").exists(),
                "{scenario} never exercised descendant"
            );
            assert!(
                !run.dir.join("work/late-activity").exists(),
                "{scenario}: late target activity"
            );
        }
        if *scenario == "forge" {
            assert_eq!(
                run.stdout,
                frame(1, 1, 0),
                "matching-ID forgery travels only over ACP stdout"
            );
            assert!(run.dir.join("work/forge-rejected").exists());
            assert!(run.dir.join("work/pre-restriction-fds").exists());
        }
        if *scenario == "acp" {
            assert!(String::from_utf8_lossy(&run.stdout).contains("fixture-session"));
        }
        if *scenario == "acp-forbidden" {
            assert!(run.dir.join("work/forbidden-rejected").exists());
        }
        if *scenario == "acp-hang" {
            assert!(run.dir.join("work/hung-request").exists());
        }
        if *detail == 4 {
            assert!(!run.dir.join("work/executed").exists());
        }
        remove_transport_files(&run.dir); // Strict proven join completed, including real EOF.
    }
    remove_transport_fixture(&fixture);
    eprintln!("transport native matrix: 23 actual namespace/stream cases passed");
}

#[test]
fn transport_refusals_execute_zero_targets() {
    let Some(fixture) = Fixture::new() else {
        return;
    };
    for (scenario, code, detail) in [
        ("not-a-scenario", 64, 1),
        ("clone-failure", 65, 2),
        ("pidfd-failure", 65, 2),
    ] {
        let run = fixture.transport(scenario, scenario, TransportAction::None);
        assert_eq!(run.code, code);
        exact_record(&run, frame(2, detail, 0));
        no_execution(&run);
        remove_transport_files(&run.dir);
    }
    let alias = fixture.transport("normal", "invalid-fd-alias", TransportAction::InvalidLayout);
    assert_eq!(alias.code, 64);
    exact_record(&alias, frame(2, 1, 0));
    no_execution(&alias);
    remove_transport_files(&alias.dir);
    remove_transport_fixture(&fixture);
}

#[test]
fn transport_verifier_loss_never_becomes_guard_success() {
    let Some(fixture) = Fixture::new() else {
        return;
    };
    let normal = fixture.transport("normal", "facility-check", TransportAction::None);
    if normal.code == 65 {
        exact_record(&normal, frame(2, 2, 0));
        no_execution(&normal);
        eprintln!(
            "SKIP transport verifier/producer loss matrix: actual namespace/pidfd creation unavailable; zero target admission checked"
        );
        remove_transport_files(&normal.dir);
        remove_transport_fixture(&fixture);
        return;
    }
    assert_eq!(normal.code, 0);
    exact_record(&normal, frame(1, 1, 7));
    remove_transport_files(&normal.dir);
    let cases = [
        "death-pre-admission",
        "death-post-admission",
        "death-mid-record",
        "death-full-record",
        "death-closed-record",
        "proof-truncate",
        "proof-stale",
        "proof-extra",
        "proof-missing",
        "guard-eof",
        "guard-registration-failure",
        "wait-failure",
        "withhold",
    ];
    for scenario in cases {
        let action = if scenario == "withhold" {
            TransportAction::StopEof
        } else {
            TransportAction::None
        };
        let run = fixture.transport(scenario, scenario, action);
        let expected_code = match scenario {
            "proof-truncate" | "proof-stale" | "proof-extra" | "proof-missing" => 0,
            "wait-failure" | "withhold" => 70,
            _ => 71,
        };
        assert_eq!(
            run.code, expected_code,
            "{scenario}: exit {} {:?}",
            run.code, run.stderr
        );
        assert!(
            !run.dir.join("work/late-activity").exists(),
            "{scenario}: finite guard safety failed"
        );
        match scenario {
            "death-pre-admission" | "guard-eof" | "guard-registration-failure" => {
                no_execution(&run)
            }
            "death-mid-record" => {
                assert_eq!(run.proof_bytes, 16);
                assert_eq!(run.proof, frame(1, 1, 7)[..16]);
            }
            "proof-truncate" => {
                assert_eq!(run.proof_bytes, 31);
                assert_eq!(run.proof, frame(1, 1, 7)[..31]);
            }
            "death-full-record" | "death-closed-record" => {
                exact_record(&run, frame(1, 1, 7));
            }
            "proof-stale" => {
                let mut stale = frame(1, 1, 7);
                stale[8] ^= 1;
                exact_record(&run, stale);
            }
            "proof-extra" => {
                assert_eq!(run.proof_bytes, 64);
                assert_eq!(run.proof, [frame(1, 1, 7), frame(1, 1, 7)].concat());
            }
            "proof-missing" => assert_eq!(run.proof_bytes, 0),
            "wait-failure" | "withhold" => exact_record(&run, frame(3, 1, 0)),
            _ => {}
        }
        // A clean guard exit cannot repair missing/invalid/stale framing. Retain
        // these directories too: none supplies the entire acceptance join.
        // An independent adopted-init reap never repairs verifier loss either.
    }
    let closed = fixture.transport("normal", "proof-peer-closed", TransportAction::CloseProof);
    assert_eq!(
        closed.code, 71,
        "closed proof endpoint must reject producer success"
    );
    assert_eq!(closed.proof_bytes, 0);
    eprintln!("transport loss matrix: 14 cases passed; all 14 finite case directories retained");
}

fn bound_a_observed(run: &TransportRun) {
    assert!(run.dir.join("work/image-a-executed").exists());
    assert!(!run.dir.join("work/image-b-executed").exists());
    assert!(run.dir.join("work/fd-closed").exists());
    assert_eq!(
        fs::read_to_string(run.dir.join("work/pre-restriction-fds")).unwrap(),
        "owned sealed image fd3; controls closed\n"
    );
}

#[test]
fn sealed_image_bound_namespace_matrix() {
    let Some(fixture) = Fixture::new() else {
        return;
    };
    let normal = fixture.bound_transport("normal", "bound-normal", TransportAction::None);
    if normal.code == 65 {
        exact_record(&normal, frame(2, 2, 0));
        no_execution(&normal);
        eprintln!(
            "SKIP bound image actual acceptance: required native fixture/kernel facilities unavailable; zero target admission; not positive acceptance"
        );
        remove_transport_files(&normal.dir);
        remove_transport_fixture(&fixture);
        return;
    }
    assert_eq!(normal.code, 0, "bound normal: {:?}", normal.stderr);
    exact_record(&normal, frame(1, 1, 7));
    bound_a_observed(&normal);
    remove_transport_files(&normal.dir);
    for scenario in ["sealed-replace", "sealed-mutate", "seal-aliases"] {
        let run = fixture.bound_transport(scenario, scenario, TransportAction::None);
        assert_eq!(run.code, 0, "{scenario}: {:?}", run.stderr);
        exact_record(&run, frame(1, 1, 7));
        bound_a_observed(&run);
        if scenario == "seal-aliases" {
            assert!(run.dir.join("work/sealed-aliases-ok").exists());
        }
        remove_transport_files(&run.dir);
    }
    let sandbox = fixture.bound_transport("sandbox", "bound-sandbox", TransportAction::None);
    assert_eq!(sandbox.code, 0);
    exact_record(&sandbox, frame(1, 1, 0));
    bound_a_observed(&sandbox);
    assert!(sandbox.dir.join("work/sandbox-ok").exists());
    remove_transport_files(&sandbox.dir);
    let refusals = [
        "before-copy-b",
        "copy-torn",
        "copy-truncate",
        "copy-grow",
        "copy-b",
        "image-mismatch",
        "prep-expired",
        "prep-entry-expired",
        "prep-validation-expired",
        "prep-stop",
        "fault-open",
        "fault-read",
        "fault-write",
        "fault-mode",
        "fault-seal",
        "fault-readback",
        "fault-compare",
        "fault-close",
        "writable-map",
    ];
    for scenario in refusals {
        let run = fixture.bound_transport(scenario, scenario, TransportAction::None);
        assert_eq!(
            run.code,
            if scenario == "image-mismatch" { 64 } else { 66 },
            "{scenario}: {:?}",
            run.stderr
        );
        exact_record(
            &run,
            frame(2, if scenario == "image-mismatch" { 1 } else { 3 }, 0),
        );
        no_execution(&run);
        assert!(!run.dir.join("work/image-a-executed").exists());
        assert!(!run.dir.join("work/image-b-executed").exists());
        remove_transport_files(&run.dir);
    }
    for scenario in [
        "fault-dup",
        "fault-close-range",
        "fault-inventory",
        "fault-exec",
        "restrict-failure",
        "limits-failure",
        "exec-failure",
        "map-failure",
        "prep-gate-expired",
        "prep-release-expired",
        "prep-exec-expired",
    ] {
        let run = fixture.bound_transport(scenario, scenario, TransportAction::None);
        assert_eq!(run.code, 0, "{scenario}: {:?}", run.stderr);
        exact_record(&run, frame(1, 4, 0));
        assert!(!run.dir.join("work/executed").exists());
        assert!(!run.dir.join("work/image-a-executed").exists());
        assert!(!run.dir.join("work/image-b-executed").exists());
        assert!(!run.dir.join("work/descendant-ready").exists());
        assert!(!run.dir.join("work/late-activity").exists());
        if matches!(scenario, "prep-gate-expired" | "prep-release-expired") {
            no_execution(&run);
        }
        if scenario == "prep-exec-expired" {
            assert!(run.dir.join("work/pre-restriction-fds").exists());
        }
        remove_transport_files(&run.dir);
    }
    for (scenario, action, detail, value) in [
        ("direct", TransportAction::None, 1, 0),
        ("double", TransportAction::None, 1, 0),
        ("detach", TransportAction::None, 1, 0),
        ("signal-tree", TransportAction::None, 2, 15),
        ("kill-init", TransportAction::None, 2, 9),
        ("hold", TransportAction::StopEof, 3, 0),
        ("hold", TransportAction::StopData, 3, 0),
        ("forge", TransportAction::None, 1, 0),
        ("acp", TransportAction::Acp, 1, 0),
        ("acp-hang", TransportAction::Hung, 3, 0),
    ] {
        let label = format!("bound-{scenario}-{detail}-{value}");
        // Repeated hold cases get a distinct finite owner label.
        let label = if matches!(action, TransportAction::StopData) {
            format!("{label}-data")
        } else {
            label
        };
        let run = fixture.bound_transport(scenario, &label, action);
        assert_eq!(run.code, 0, "{scenario}: {:?}", run.stderr);
        exact_record(&run, frame(1, detail, value));
        bound_a_observed(&run);
        if [
            "direct",
            "double",
            "detach",
            "signal-tree",
            "kill-init",
            "hold",
        ]
        .contains(&scenario)
        {
            assert!(run.dir.join("work/descendant-ready").exists());
            assert!(!run.dir.join("work/late-activity").exists());
        }
        if scenario == "forge" {
            assert_eq!(run.stdout, frame(1, 1, 0));
        }
        remove_transport_files(&run.dir);
    }
    for scenario in [
        "death-pre-admission",
        "death-post-admission",
        "death-mid-record",
        "death-full-record",
        "proof-stale",
        "proof-missing",
        "wait-failure",
        "withhold",
        "prep-gate-expired-unproven",
    ] {
        let run = fixture.bound_transport(
            scenario,
            &format!("bound-loss-{scenario}"),
            if scenario == "withhold" {
                TransportAction::StopEof
            } else {
                TransportAction::None
            },
        );
        assert_eq!(
            run.code,
            match scenario {
                "proof-stale" | "proof-missing" => 0,
                "wait-failure" | "withhold" | "prep-gate-expired-unproven" => 70,
                _ => 71,
            }
        );
        assert!(!run.dir.join("work/late-activity").exists());
        if matches!(
            scenario,
            "death-pre-admission" | "prep-gate-expired-unproven"
        ) {
            no_execution(&run);
            assert!(!run.dir.join("work/image-a-executed").exists());
            assert!(!run.dir.join("work/image-b-executed").exists());
            assert!(!run.dir.join("work/descendant-ready").exists());
        }
        // Missing strict owned proof leaves all finite files retained, even when
        // independent guard safety was established. No adopted-reap authority.
    }
    eprintln!(
        "bound image native matrix: 5 image/restriction positives, 19 zero-target preparation refusals, 11 setup-failed exact reaps, 10 lifetime/ACP positives, 9 retained proof-loss cases; retained root {}",
        fixture.dir.display()
    );
}

#[test]
fn bound_sources_refuse_before_namespace_creation() {
    if !probe_artifact::fixture_available() {
        eprintln!("SKIP bound source native refusals: fixed static assets unavailable");
        return;
    }
    let Some(fixture) = Fixture::new() else {
        return;
    };
    for case in [
        "script",
        "et-dyn",
        "machine",
        "interpreter",
        "dynamic",
        "truncated",
        "ph-overflow",
        "entry",
        "oversize",
        "symlink",
        "hardlink",
        "mode",
        "small",
    ] {
        let run = fixture.transport_config(
            "normal",
            &format!("source-{case}"),
            TransportAction::None,
            true,
            |path| {
                let mut bytes = probe_artifact::EMBEDDED_A.to_vec();
                let ph = u64::from_le_bytes(bytes[32..40].try_into().unwrap()) as usize;
                match case {
                    "script" => {
                        bytes = b"#!/bin/sh\nexit 0\n".repeat(8);
                    }
                    "et-dyn" => bytes[16..18].copy_from_slice(&3u16.to_le_bytes()),
                    "machine" => bytes[18..20].copy_from_slice(&183u16.to_le_bytes()),
                    "interpreter" => bytes[ph..ph + 4].copy_from_slice(&3u32.to_le_bytes()),
                    "dynamic" => bytes[ph..ph + 4].copy_from_slice(&2u32.to_le_bytes()),
                    "truncated" => bytes.truncate(80),
                    "ph-overflow" => bytes[32..40].copy_from_slice(&u64::MAX.to_le_bytes()),
                    "entry" => bytes[24..32].copy_from_slice(&0u64.to_le_bytes()),
                    "oversize" => bytes.resize(4 * 1024 * 1024 + 1, 0),
                    "small" => bytes.truncate(63),
                    "symlink" => {
                        let other = path.with_file_name("artifact-other");
                        fs::rename(path, &other).unwrap();
                        std::os::unix::fs::symlink(other, path).unwrap();
                        return;
                    }
                    "hardlink" => {
                        fs::hard_link(path, path.with_file_name("artifact-link")).unwrap();
                        return;
                    }
                    "mode" => {
                        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
                        return;
                    }
                    _ => unreachable!(),
                }
                fs::write(path, bytes).unwrap();
            },
        );
        assert_eq!(run.code, 66, "{case}: {:?}", run.stderr);
        exact_record(&run, frame(2, 3, 0));
        no_execution(&run);
        remove_transport_files(&run.dir);
    }
    remove_transport_fixture(&fixture);
    eprintln!("bound source native matrix: 13 zero-target refusals");
}

// Explicit context acceptance is separate from the pathname/image matrices. All
// assets and allocations are created before the first capture; nothing here
// removes a successful allocation, a displaced directory, or bootstrap data.
const CONTEXT_LEAVES: [&str; 9] = [
    "cwd", "home", "config", "cache", "data", "state", "runtime", "tmp", "empty",
];
const CONTEXT_RETAINED_MANIFEST: &str = "/tmp/gc-context-native-retained-paths.txt";

#[derive(Clone, Copy)]
enum ContextExpected {
    Accepted(u8, u32),
    Refused,
    Invalid,
    Unavailable,
    SetupFailed,
    Unproven(i32),
}
struct ContextSpec {
    scenario: String,
    action: TransportAction,
    expected: ContextExpected,
    poisoned: bool,
}
struct ContextCase {
    spec: ContextSpec,
    dir: PathBuf,
    bootstrap: PathBuf,
    root: PathBuf,
    identities: Vec<String>,
    invocation: [u8; 16],
    invocation_hex: String,
    poisoned: bool,
}
fn context_random<const N: usize>() -> [u8; N] {
    let mut bytes = [0; N];
    assert_eq!(
        unsafe { libc::getrandom(bytes.as_mut_ptr().cast(), N, 0) },
        N as isize
    );
    bytes
}
fn context_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn context_directory(path: &Path) {
    fs::DirBuilder::new().mode(0o700).create(path).unwrap();
}
fn context_frame(case: &ContextCase, kind: u8, detail: u8, value: u32) -> [u8; 32] {
    let mut record = frame(kind, detail, value);
    record[8..24].copy_from_slice(&case.invocation);
    record
}
impl ContextCase {
    fn prepare(base: &Path, index: usize, spec: ContextSpec) -> Self {
        let dir = base.join(format!("{index:03}-{}", spec.scenario));
        context_directory(&dir);
        let bootstrap = dir.join("bootstrap");
        context_directory(&bootstrap);
        context_directory(&bootstrap.join("work"));
        let source = bootstrap.join("artifact");
        fs::write(&source, probe_artifact::EMBEDDED_A).unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o700)).unwrap();
        let parent = dir.join("parent");
        context_directory(&parent);
        // A must deny handled access to an existing regular neighbor. ENOENT
        // would provide no evidence that this ungranted file is protected.
        fs::write(parent.join("neighbor"), b"ungranted fixture neighbor\n").unwrap();
        let root = parent.join(format!("context-{}", context_hex(&context_random::<16>())));
        context_directory(&root);
        let mut identities = Vec::with_capacity(20);
        for path in
            std::iter::once(root.clone()).chain(CONTEXT_LEAVES.iter().map(|leaf| root.join(leaf)))
        {
            if path != root {
                context_directory(&path);
            }
            let metadata = fs::symlink_metadata(&path).unwrap();
            assert!(metadata.is_dir());
            assert_eq!(metadata.mode() & 0o7777, 0o700);
            identities.push(metadata.dev().to_string());
            identities.push(metadata.ino().to_string());
        }
        let invocation = context_random::<16>();
        let invocation_hex = context_hex(&invocation);
        let poisoned = spec.poisoned;
        let case = Self {
            spec,
            dir,
            bootstrap,
            root,
            identities,
            invocation,
            invocation_hex,
            poisoned,
        };
        fs::write(
            case.bootstrap.join("selection.json"),
            serde_json::to_vec(&serde_json::json!({
                "scenario": case.spec.scenario,
                "bootstrap": case.bootstrap.join("work"),
                "root": case.root,
                "identities": case.identities,
                "invocation": case.invocation_hex,
                "ambient_poisoned": case.poisoned
            }))
            .unwrap(),
        )
        .unwrap();
        // Precreate result files too, so recording never mutates an ancestor's
        // directory entries while a native capture is active.
        for name in ["result.txt", "driver-out", "driver-err", "proof.bin"] {
            fs::write(case.bootstrap.join(name), []).unwrap();
        }
        case
    }
    fn run(&self) -> TransportRun {
        let fixture = Fixture {
            dir: self.bootstrap.clone(),
            binary: self.bootstrap.join("artifact"),
        };
        fixture.transport_prepared(
            &self.spec.scenario,
            self.spec.action,
            self.bootstrap.clone(),
            fixture.binary.clone(),
            true,
            Some(self),
        )
    }
    fn cwd(&self) -> PathBuf {
        self.root.join("cwd")
    }
    fn no_context_execution(&self) {
        fn check(path: &Path, depth: usize, count: &mut usize) {
            *count += 1;
            assert!(
                depth <= 8 && *count < 128,
                "finite no-execution inventory exceeded"
            );
            assert!(
                ![
                    "executed",
                    "image-a-executed",
                    "image-b-executed",
                    "context-ok",
                    "fd-closed",
                    "descendant-ready",
                    "late-activity",
                    "pre-restriction-fds"
                ]
                .iter()
                .any(|name| path.file_name().is_some_and(|actual| actual == *name)),
                "refusal/setup failure executed A at {}",
                path.display()
            );
            if fs::symlink_metadata(path).unwrap().is_dir() {
                for child in fs::read_dir(path).unwrap() {
                    check(&child.unwrap().path(), depth + 1, count);
                }
            }
        }
        check(&self.dir, 0, &mut 0);
        for name in [
            "executed",
            "image-a-executed",
            "image-b-executed",
            "context-ok",
            "fd-closed",
            "descendant-ready",
            "late-activity",
            "pre-restriction-fds",
        ] {
            assert!(
                !self.cwd().join(name).exists(),
                "{}: unexpected {name}",
                self.spec.scenario
            );
        }
        assert!(!self.bootstrap.join("work/executed").exists());
    }
    fn accepted_context(&self) {
        for name in ["executed", "image-a-executed", "fd-closed", "context-ok"] {
            assert!(
                self.cwd().join(name).is_file(),
                "{}: missing {name}",
                self.spec.scenario
            );
        }
        assert!(!self.cwd().join("image-b-executed").exists());
        assert!(!self.cwd().join("pre-restriction-fds").exists());
        assert!(!self.bootstrap.join("work/executed").exists());
        for (i, leaf) in CONTEXT_LEAVES.iter().enumerate() {
            let path = self.root.join(leaf);
            let metadata = fs::symlink_metadata(&path).unwrap();
            assert_eq!(metadata.dev().to_string(), self.identities[2 * i + 2]);
            assert_eq!(metadata.ino().to_string(), self.identities[2 * i + 3]);
            if i < 8 {
                assert_eq!(fs::read(path.join("context-write")).unwrap(), b"fixture\n");
            } else {
                assert_eq!(fs::read_dir(path).unwrap().count(), 0);
            }
        }
        let root = fs::symlink_metadata(&self.root).unwrap();
        assert_eq!(root.dev().to_string(), self.identities[0]);
        assert_eq!(root.ino().to_string(), self.identities[1]);
        assert!(!self.root.join("denied-write").exists());
        assert!(!self.root.join("empty/denied-write").exists());
    }
    fn mutation_observed(&self) {
        let scenario = &self.spec.scenario;
        if scenario == "ctx-after-landlock-symlink" {
            let path = self.cwd().join("context-fault-link");
            assert!(
                fs::symlink_metadata(&path)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            assert_eq!(
                fs::read_link(path).unwrap(),
                Path::new("context-fault-entry")
            );
            return;
        }
        let selected = if scenario.ends_with("ancestor-replace")
            || scenario.ends_with("ancestor-symlink")
            || scenario.ends_with("ancestor-missing")
            || scenario.ends_with("ancestor-mode")
        {
            self.root.parent().unwrap().to_path_buf()
        } else if scenario.ends_with("leaf-replace")
            || scenario.ends_with("leaf-symlink")
            || scenario.ends_with("leaf-missing")
            || scenario.ends_with("leaf-mode")
        {
            self.cwd()
        } else {
            self.root.clone()
        };
        if scenario.ends_with("-replace")
            || scenario.ends_with("-symlink")
            || scenario.ends_with("-missing")
        {
            let moved = PathBuf::from(format!("{}.moved", selected.display()));
            assert!(
                fs::symlink_metadata(&moved).unwrap().is_dir(),
                "{scenario}: no actual displacement"
            );
            if scenario.ends_with("-replace") {
                assert!(fs::symlink_metadata(&selected).unwrap().is_dir());
                let old = fs::symlink_metadata(&moved).unwrap();
                let new = fs::symlink_metadata(&selected).unwrap();
                assert_ne!((old.dev(), old.ino()), (new.dev(), new.ino()));
            } else if scenario.ends_with("-symlink") {
                assert!(
                    fs::symlink_metadata(&selected)
                        .unwrap()
                        .file_type()
                        .is_symlink()
                );
                assert_eq!(fs::read_link(selected).unwrap(), moved);
            } else {
                assert!(
                    matches!(fs::symlink_metadata(selected), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
                );
            }
        } else if scenario.ends_with("-mode") {
            assert_eq!(
                fs::symlink_metadata(selected).unwrap().mode() & 0o7777,
                0o750
            );
        } else if scenario.ends_with("-nonempty") || scenario == "ctx-after-landlock-content" {
            assert!(
                self.cwd().join("context-fault-entry").is_file(),
                "{scenario}: mutation not exercised"
            );
        } else if scenario.ends_with("-extra-root") {
            assert!(self.root.join("context-fault-entry").is_file());
        }
    }
    fn record_retention(&self, status: &str, run: Option<&TransportRun>) {
        // Never follow a replacement symlink. A bounded walk of this one finite
        // case locates every original directory, including displaced trees.
        fn visit(path: &Path, depth: usize, entries: &mut Vec<(PathBuf, u64, u64, bool)>) {
            assert!(
                depth <= 8 && entries.len() < 128,
                "finite retention inventory exceeded"
            );
            let metadata = fs::symlink_metadata(path).unwrap();
            entries.push((
                path.to_path_buf(),
                metadata.dev(),
                metadata.ino(),
                metadata.is_dir(),
            ));
            if metadata.is_dir() {
                let mut children: Vec<_> = fs::read_dir(path)
                    .unwrap()
                    .map(|e| e.unwrap().path())
                    .collect();
                children.sort();
                for child in children {
                    visit(&child, depth + 1, entries);
                }
            }
        }
        let mut entries = Vec::new();
        visit(&self.dir, 0, &mut entries);
        for id in self.identities.chunks_exact(2) {
            assert!(
                entries.iter().any(|(_, dev, ino, directory)| *directory
                    && dev.to_string() == id[0]
                    && ino.to_string() == id[1]),
                "{}: original allocation disappeared: {id:?}",
                self.spec.scenario
            );
        }
        let mut manifest = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(CONTEXT_RETAINED_MANIFEST)
            .unwrap();
        writeln!(
            manifest,
            "status={status} scenario={} invocation={} bootstrap={} root={}",
            self.spec.scenario,
            self.invocation_hex,
            self.bootstrap.display(),
            self.root.display()
        )
        .unwrap();
        for (path, dev, ino, _) in entries {
            writeln!(
                manifest,
                "retained dev={dev} ino={ino} path={}",
                path.display()
            )
            .unwrap();
        }
        if let Some(run) = run {
            fs::write(self.bootstrap.join("driver-out"), &run.stdout).unwrap();
            fs::write(self.bootstrap.join("driver-err"), &run.stderr).unwrap();
            fs::write(self.bootstrap.join("proof.bin"), &run.proof).unwrap();
            fs::write(self.bootstrap.join("result.txt"),
                format!("{status} driver_exit={} proof_bytes={} proof_end={} stdout_end=true stderr_end=true elapsed_ms={} stop_to_join_ms={}\n",
                    run.code, run.proof_bytes, run.proof_ended, run.elapsed.as_millis(),
                    run.stop_requested.map_or_else(|| "none".to_owned(),
                        |stop| run.joined.duration_since(stop).as_millis().to_string()))).unwrap();
        }
        eprintln!(
            "context {}: {status}; retained {}",
            self.spec.scenario,
            self.dir.display()
        );
    }
}

fn context_specs() -> Vec<ContextSpec> {
    use ContextExpected::*;
    let mut specs = Vec::new();
    let mut add = |scenario: &str, action, expected, poisoned| {
        specs.push(ContextSpec {
            scenario: scenario.to_owned(),
            action,
            expected,
            poisoned,
        })
    };
    add("normal", TransportAction::None, Accepted(1, 7), false);
    add("normal", TransportAction::None, Accepted(1, 7), true);
    for stage in ["before-capture", "before-acquire", "after-acquire"] {
        for mutation in [
            "root-replace",
            "leaf-replace",
            "ancestor-replace",
            "root-symlink",
            "leaf-symlink",
            "ancestor-symlink",
            "root-missing",
            "leaf-missing",
            "ancestor-missing",
            "root-mode",
            "leaf-mode",
            "ancestor-mode",
            "nonempty",
            "extra-root",
        ] {
            add(
                &format!("ctx-{stage}-{mutation}"),
                TransportAction::None,
                if stage == "before-capture" {
                    Refused
                } else {
                    SetupFailed
                },
                false,
            );
        }
    }
    for scenario in ["ctx-after-landlock-content", "ctx-after-landlock-symlink"] {
        add(scenario, TransportAction::None, SetupFailed, false);
    }
    for scenario in ["ctx-stat", "ctx-deadline-capture"] {
        add(scenario, TransportAction::None, Refused, false);
    }
    for scenario in [
        "ctx-open",
        "ctx-fchdir",
        "ctx-rules",
        "ctx-limits",
        "ctx-close",
        "ctx-initial-inventory",
        "ctx-final-inventory",
        "ctx-scanner-close",
        "ctx-deadline-acquire",
        "ctx-deadline-enumeration",
        "ctx-deadline-rules",
        "ctx-deadline-revalidation",
        "ctx-deadline-closure",
        "ctx-deadline-exec",
        "fault-dup",
        "fault-close-range",
        "fault-inventory",
        "fault-exec",
        "restrict-failure",
        "limits-failure",
        "exec-failure",
        "map-failure",
    ] {
        add(scenario, TransportAction::None, SetupFailed, false);
    }
    for scenario in ["image-mismatch", "prep-expired", "prep-stop", "copy-b"] {
        add(
            scenario,
            TransportAction::None,
            if scenario == "image-mismatch" {
                Invalid
            } else {
                Refused
            },
            false,
        );
    }
    add("not-a-scenario", TransportAction::None, Invalid, false);
    add("clone-failure", TransportAction::None, Unavailable, false);
    add("pidfd-failure", TransportAction::None, Unavailable, false);
    for (scenario, action, detail, value) in [
        ("high-exit", TransportAction::None, 1, 200),
        ("signal", TransportAction::None, 2, libc::SIGTERM as u32),
        ("direct", TransportAction::None, 1, 0),
        ("double", TransportAction::None, 1, 0),
        ("detach", TransportAction::None, 1, 0),
        (
            "signal-tree",
            TransportAction::None,
            2,
            libc::SIGTERM as u32,
        ),
        ("hold", TransportAction::StopData, 3, 0),
        ("hold", TransportAction::StopRepeated, 3, 0),
        ("hold", TransportAction::StopEof, 3, 0),
        ("hold", TransportAction::StopWriteFailure, 3, 0),
        ("forge", TransportAction::None, 1, 0),
        ("acp", TransportAction::Acp, 1, 0),
        ("acp-forbidden", TransportAction::Forbidden, 1, 0),
        ("acp-hang", TransportAction::Hung, 3, 0),
    ] {
        add(scenario, action, Accepted(detail, value), false);
    }
    for scenario in [
        "death-pre-admission",
        "death-post-admission",
        "death-mid-record",
        "death-full-record",
        "death-closed-record",
        "proof-truncate",
        "proof-stale",
        "proof-extra",
        "proof-missing",
        "guard-eof",
        "guard-registration-failure",
        "wait-failure",
        "withhold",
    ] {
        add(
            scenario,
            if scenario == "withhold" {
                TransportAction::StopEof
            } else {
                TransportAction::None
            },
            Unproven(match scenario {
                "proof-truncate" | "proof-stale" | "proof-extra" | "proof-missing" => 0,
                "wait-failure" | "withhold" => 70,
                _ => 71,
            }),
            false,
        );
    }
    add("normal", TransportAction::CloseProof, Unproven(71), false);
    add("normal", TransportAction::InvalidLayout, Invalid, false);
    specs
}

fn context_join_timing(scenario: &str, run: &TransportRun) {
    assert!(
        run.elapsed <= Duration::from_secs(11),
        "{scenario}: proof/END/exact-exit join exceeded owner budget; retained"
    );
    if let Some(stop) = run.stop_requested {
        assert!(
            run.joined.duration_since(stop) <= Duration::from_secs(3),
            "{scenario}: proof/END/exact-exit join exceeded stop budget; retained"
        );
    }
}

fn context_check(case: &ContextCase, run: &TransportRun) -> &'static str {
    use ContextExpected::*;
    let scenario = case.spec.scenario.as_str();
    let expected = |kind, detail, value| context_frame(case, kind, detail, value);
    match case.spec.expected {
        Accepted(detail, value) => {
            context_join_timing(scenario, run);
            assert_eq!(
                run.code,
                0,
                "{scenario}: {:?}",
                String::from_utf8_lossy(&run.stderr)
            );
            exact_record(run, expected(1, detail, value));
            case.accepted_context();
            if ["direct", "double", "detach", "signal-tree", "hold"].contains(&scenario) {
                assert!(case.cwd().join("descendant-ready").exists());
                assert!(!case.cwd().join("late-activity").exists());
            }
            if scenario == "forge" {
                assert_eq!(
                    run.stdout,
                    expected(1, 1, 0),
                    "ACP forgery is not owned proof"
                );
                assert!(case.cwd().join("forge-rejected").exists());
            }
            if scenario == "acp" {
                assert!(String::from_utf8_lossy(&run.stdout).contains("fixture-session"));
            }
            if scenario == "acp-forbidden" {
                assert!(case.cwd().join("forbidden-rejected").exists());
            }
            if scenario == "acp-hang" {
                assert!(case.cwd().join("hung-request").exists());
            }
            "pass"
        }
        Refused | Invalid | Unavailable => {
            let (code, detail, status) = match case.spec.expected {
                Refused => (66, 3, "refusal"),
                Invalid => (64, 1, "refusal"),
                Unavailable => (65, 2, "unavailable"),
                _ => unreachable!(),
            };
            assert_eq!(
                run.code,
                code,
                "{scenario}: {:?}",
                String::from_utf8_lossy(&run.stderr)
            );
            exact_record(run, expected(2, detail, 0));
            case.no_context_execution();
            case.mutation_observed();
            status
        }
        SetupFailed => {
            context_join_timing(scenario, run);
            assert_eq!(
                run.code,
                0,
                "{scenario}: {:?}",
                String::from_utf8_lossy(&run.stderr)
            );
            exact_record(run, expected(1, 4, 0));
            case.no_context_execution();
            case.mutation_observed();
            "setup-failed"
        }
        Unproven(code) => {
            assert_eq!(
                run.code,
                code,
                "{scenario}: {:?}",
                String::from_utf8_lossy(&run.stderr)
            );
            assert!(!case.cwd().join("late-activity").exists());
            match scenario {
                "death-pre-admission" | "guard-eof" | "guard-registration-failure" => {
                    case.no_context_execution()
                }
                "death-mid-record" => {
                    assert_eq!(run.proof_bytes, 16);
                    assert_eq!(run.proof, expected(1, 1, 7)[..16]);
                }
                "proof-truncate" => {
                    assert_eq!(run.proof_bytes, 31);
                    assert_eq!(run.proof, expected(1, 1, 7)[..31]);
                }
                "death-full-record" | "death-closed-record" => exact_record(run, expected(1, 1, 7)),
                "proof-stale" => {
                    let mut stale = expected(1, 1, 7);
                    stale[8] ^= 1;
                    exact_record(run, stale);
                }
                "proof-extra" => {
                    assert_eq!(run.proof_bytes, 64);
                    assert_eq!(run.proof, [expected(1, 1, 7), expected(1, 1, 7)].concat());
                }
                "proof-missing" | "normal" => assert_eq!(run.proof_bytes, 0),
                "wait-failure" | "withhold" => exact_record(run, expected(3, 1, 0)),
                _ => {}
            }
            // Early A/context markers cannot repair a malformed proof or a
            // nonzero exact producer exit, including a complete 32-byte record.
            "unproven"
        }
    }
}

#[test]
fn context_join_rejects_late_owner_stop_and_setup() {
    // A valid record, END and exact exit cannot excuse a late join. Exercise
    // the real acceptance branches with synthetic monotonic times, without
    // launching targets, allocating context roots or exporting runtime helpers.
    for expected in [
        ContextExpected::Accepted(1, 7),
        ContextExpected::SetupFailed,
    ] {
        let case = ContextCase {
            spec: ContextSpec {
                scenario: "synthetic-timing".to_owned(),
                action: TransportAction::None,
                expected,
                poisoned: false,
            },
            dir: PathBuf::new(),
            bootstrap: PathBuf::new(),
            root: PathBuf::new(),
            identities: Vec::new(),
            invocation: INVOCATION,
            invocation_hex: INVOCATION_HEX.to_owned(),
            poisoned: false,
        };
        let proof = match expected {
            ContextExpected::Accepted(detail, value) => frame(1, detail, value),
            ContextExpected::SetupFailed => frame(1, 4, 0),
            _ => unreachable!(),
        };
        let started = Instant::now();
        let mut run = TransportRun {
            code: 0,
            proof: proof.to_vec(),
            proof_bytes: 32,
            stdout: Vec::new(),
            stderr: Vec::new(),
            proof_ended: true,
            elapsed: Duration::from_secs(11),
            stop_requested: None,
            joined: started + Duration::from_secs(11),
            dir: PathBuf::new(),
        };
        context_join_timing(&case.spec.scenario, &run); // Inclusive overall bound.
        run.stop_requested = Some(run.joined - Duration::from_secs(3));
        context_join_timing(&case.spec.scenario, &run); // Inclusive stop bound.
        for (elapsed, since_stop, budget) in [
            (
                Duration::from_secs(11) + Duration::from_nanos(1),
                None,
                "owner",
            ),
            (
                Duration::from_secs(4),
                Some(Duration::from_secs(3) + Duration::from_nanos(1)),
                "stop",
            ),
        ] {
            run.elapsed = elapsed;
            run.joined = started + elapsed;
            run.stop_requested = since_stop.map(|since| run.joined - since);
            let panic = std::panic::catch_unwind(|| context_check(&case, &run))
                .expect_err("late acceptance/setup join must be rejected before marker checks");
            let message = panic
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| panic.downcast_ref::<&str>().copied())
                .expect("timing assertion must explain rejection");
            assert!(message.contains(&format!("join exceeded {budget} budget")));
        }
    }
}

#[test]
#[ignore = "explicit retained context matrix; launches an isolated single-test process"]
fn context_bound_native_matrix() {
    const ISOLATED: &str = "GC_CONTEXT_NATIVE_ISOLATED";
    if std::env::var_os(ISOLATED).is_none() {
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "context_bound_native_matrix",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(ISOLATED, "1")
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        let status = Running {
            child,
            finished: false,
        }
        .wait(Duration::from_secs(240));
        assert!(
            status.success(),
            "isolated context matrix failed; all fixtures retained"
        );
        return;
    }
    if !cfg!(all(target_os = "linux", target_arch = "x86_64"))
        || !probe_artifact::fixture_available()
    {
        eprintln!(
            "context native matrix unavailable: fixed Linux x86_64 A/B assets absent; zero context launches"
        );
        return;
    }
    // Create the shared append-only manifest before capture. Keep its original
    // contents and every prior fixture untouched.
    let mut manifest = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(CONTEXT_RETAINED_MANIFEST)
        .unwrap();
    let base = Path::new("/tmp").join(format!(
        "gs-context-{}",
        context_hex(&context_random::<16>())
    ));
    context_directory(&base);
    writeln!(
        manifest,
        "matrix retained base={} dev={} ino={}",
        base.display(),
        fs::metadata(&base).unwrap().dev(),
        fs::metadata(&base).unwrap().ino()
    )
    .unwrap();
    drop(manifest);
    let cases: Vec<_> = context_specs()
        .into_iter()
        .enumerate()
        .map(|(index, spec)| ContextCase::prepare(&base, index, spec))
        .collect();
    for case in &cases {
        case.record_retention("precreated-unrun", None);
    }
    let mut counts = [0usize; 5]; // pass, refusal, unavailable, setup-failed, unproven
    for (index, case) in cases.iter().enumerate() {
        let run = case.run();
        // Environmental facilities/refusals must be reported honestly. A host
        // refusal cannot stand in for positive contextual acceptance.
        if index < 2 && matches!(run.code, 65 | 66) {
            exact_record(
                &run,
                context_frame(case, 2, if run.code == 65 { 2 } else { 3 }, 0),
            );
            case.no_context_execution();
            case.record_retention(
                if run.code == 65 {
                    "unavailable"
                } else {
                    "refusal"
                },
                Some(&run),
            );
            for unrun in &cases[index + 1..] {
                unrun.record_retention("unproven-unrun-after-facility-refusal", None);
            }
            eprintln!(
                "context native matrix: accepted={}, refusal={}, unavailable={}, setup-failed=0, unproven-unrun={}; all retained {}; positive acceptance not established",
                counts[0],
                usize::from(run.code == 66),
                usize::from(run.code == 65),
                cases.len() - index - 1,
                base.display()
            );
            return;
        }
        // Save endpoint bytes and retained identities even if an assertion below
        // detects a regression. Recording occurs only after every endpoint ended.
        case.record_retention("observed-before-assertion", Some(&run));
        let status = context_check(case, &run);
        counts[match status {
            "pass" => 0,
            "refusal" => 1,
            "unavailable" => 2,
            "setup-failed" => 3,
            _ => 4,
        }] += 1;
        case.record_retention(status, Some(&run));
    }
    assert_eq!(counts.iter().sum::<usize>(), cases.len());
    eprintln!(
        "context native matrix: pass={}, refusal={}, unavailable={}, setup-failed={}, unproven={}; total={}; all retained {}; identity and ownership changes requiring another UID remain synthetic; ARM/other runtimes/providers unclaimed",
        counts[0],
        counts[1],
        counts[2],
        counts[3],
        counts[4],
        cases.len(),
        base.display()
    );
}
