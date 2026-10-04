//! Explicit feature-only native integration fixtures. Every launch has an outer
//! watchdog as well as the native pidfd guard. Unsupported creation is reported
//! as a skip of live cases, never successful namespace acceptance.
#[path = "../src/probe_artifact.rs"]
#[allow(dead_code)]
mod probe_artifact;
#[path = "../src/probe_lifetime.rs"]
#[allow(dead_code)]
mod probe_lifetime;
use std::fs;
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
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
            .args([if bound {
                "bound-transport-v1"
            } else {
                "transport-v1"
            }])
            .arg(&target)
            .arg(scenario)
            .arg(dir.join("work"))
            .arg(dir.join("policy.json"))
            .arg(INVOCATION_HEX)
            .env_clear()
            .env("PATH", "/usr/bin")
            .env("HOME", dir.join("work"))
            .env("TMPDIR", dir.join("work"))
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
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
                | TransportAction::StopEof
                | TransportAction::StopError
                | TransportAction::StopWriteFailure => dir.join("work/descendant-ready").exists(),
                TransportAction::Hung => dir.join("work/hung-request").exists(),
                TransportAction::OutputBudget => out_bytes + err_bytes > 65_536,
                _ => false,
            };
            if ready && let Some(mut endpoint) = control.take() {
                match action {
                    TransportAction::StopData => {
                        let _ = endpoint.write(b"stop");
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
        TransportRun {
            code: status
                .unwrap()
                .code()
                .expect("outer guard must classify its exact verifier exit"),
            proof: record,
            proof_bytes,
            stdout: out,
            stderr: err,
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
