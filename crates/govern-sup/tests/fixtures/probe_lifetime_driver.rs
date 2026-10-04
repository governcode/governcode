//! Fresh single-threaded native fixture driver. The outer process is both subreaper
//! and independent wall watchdog; it receives the init pidfd before admission.
#[allow(dead_code)]
#[path = "../../src/limits.rs"]
mod limits;
#[allow(dead_code)]
#[path = "../../src/policy.rs"]
mod policy;
#[path = "../../src/probe_lifetime.rs"]
mod probe_lifetime;
#[allow(dead_code)]
#[path = "../../src/sandbox.rs"]
mod sandbox;
use probe_lifetime::{Failure, Fault, Options, Outcome, Stage};
use std::io::{Read, Write};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};
use std::time::{Duration, Instant};
use std::{fs, path::Path, process::ExitCode};

// Fixed single-byte seqpacket messages and exactly one SCM_RIGHTS descriptor.
fn packet(fd: RawFd, byte: u8, right: Option<BorrowedFd<'_>>) -> bool {
    let mut byte = byte;
    let mut iov = libc::iovec {
        iov_base: (&mut byte as *mut u8).cast(),
        iov_len: 1,
    };
    let mut buffer = [0usize; 4];
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    if let Some(right) = right {
        msg.msg_control = buffer.as_mut_ptr().cast();
        msg.msg_controllen = unsafe { libc::CMSG_SPACE(4) } as usize;
        unsafe {
            let header = libc::CMSG_FIRSTHDR(&msg);
            (*header).cmsg_level = libc::SOL_SOCKET;
            (*header).cmsg_type = libc::SCM_RIGHTS;
            (*header).cmsg_len = libc::CMSG_LEN(4) as usize;
            libc::CMSG_DATA(header)
                .cast::<i32>()
                .write(right.as_raw_fd());
        }
    }
    unsafe { libc::sendmsg(fd, &msg, libc::MSG_NOSIGNAL | libc::MSG_DONTWAIT) == 1 }
}
fn recv(fd: RawFd) -> Result<Option<(u8, Option<OwnedFd>)>, ()> {
    let mut bytes = [0u8; 2];
    let mut iov = libc::iovec {
        iov_base: bytes.as_mut_ptr().cast(),
        iov_len: 2,
    };
    let mut buffer = [0usize; 4];
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = buffer.as_mut_ptr().cast();
    msg.msg_controllen = std::mem::size_of_val(&buffer);
    let n = unsafe { libc::recvmsg(fd, &mut msg, libc::MSG_DONTWAIT | libc::MSG_CMSG_CLOEXEC) };
    if n < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EAGAIN) {
        return Ok(None);
    }
    if n != 1 || msg.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) != 0 {
        return Err(());
    }
    let header = unsafe { libc::CMSG_FIRSTHDR(&msg) };
    let right = if header.is_null() {
        None
    } else {
        unsafe {
            if (*header).cmsg_level != libc::SOL_SOCKET
                || (*header).cmsg_type != libc::SCM_RIGHTS
                || (*header).cmsg_len != libc::CMSG_LEN(4) as usize
                || !libc::CMSG_NXTHDR(&msg, header).is_null()
            {
                return Err(());
            }
            Some(OwnedFd::from_raw_fd(
                libc::CMSG_DATA(header).cast::<i32>().read(),
            ))
        }
    };
    Ok(Some((bytes[0], right)))
}
fn pair() -> [OwnedFd; 2] {
    let mut fds = [-1; 2];
    assert_eq!(
        unsafe {
            libc::socketpair(
                libc::AF_UNIX,
                libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC,
                0,
                fds.as_mut_ptr(),
            )
        },
        0
    );
    fds.map(|fd| unsafe { OwnedFd::from_raw_fd(fd) })
}
fn wait_ack(fd: RawFd, deadline: Instant) -> Result<(), Failure> {
    while Instant::now() < deadline {
        match recv(fd) {
            Ok(Some((b'A', None))) => return Ok(()),
            Ok(None) => std::thread::sleep(Duration::from_millis(2)),
            _ => return Err(Failure::Admission),
        }
    }
    Err(Failure::Admission)
}
fn clear_inherited_capabilities() -> bool {
    #[repr(C)]
    struct Header {
        version: u32,
        pid: i32,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Data {
        effective: u32,
        permitted: u32,
        inheritable: u32,
    }
    let mut header = Header {
        version: 0x20080522,
        pid: 0,
    };
    let data = [Data::default(); 2];
    unsafe {
        libc::syscall(libc::SYS_capset, &mut header, data.as_ptr()) == 0
            && libc::prctl(
                libc::PR_CAP_AMBIENT,
                libc::PR_CAP_AMBIENT_CLEAR_ALL,
                0,
                0,
                0,
            ) == 0
    }
}
fn main() -> ExitCode {
    if !clear_inherited_capabilities() {
        return ExitCode::from(90);
    }
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 5 {
        return ExitCode::from(90);
    }
    let (mode, dir, binary, policy_file) =
        (&args[1], Path::new(&args[2]), &args[3], Path::new(&args[4]));
    let policy = match policy::read_bounded(policy_file).and_then(|s| policy::parse(&s)) {
        Ok(p) => p,
        Err(_) => return ExitCode::from(90),
    };
    if fs::read_dir("/proc/self/task").unwrap().count() != 1 {
        return ExitCode::from(90);
    }
    assert_eq!(
        unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) },
        0
    );
    let [guard, verifier] = pair();
    let [stop_read, stop_write] = pair();
    let stdin = fs::File::open("/dev/null").unwrap();
    let stdout = fs::File::create(dir.join("target-out")).unwrap();
    let stderr = fs::File::create(dir.join("target-err")).unwrap();
    let guard_pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) } as i32;
    if guard_pidfd < 0 {
        return ExitCode::from(90);
    }
    let guard_pidfd = unsafe { OwnedFd::from_raw_fd(guard_pidfd) };
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return ExitCode::from(90);
    }
    if pid == 0 {
        if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) } != 0 {
            unsafe {
                libc::_exit(90);
            }
        }
        let mut poll = libc::pollfd {
            fd: guard_pidfd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        if unsafe { libc::poll(&mut poll, 1, 0) } != 0 {
            unsafe {
                libc::_exit(90);
            }
        }
        drop(guard_pidfd);
        drop(guard);
        drop(stop_write);
        if std::env::set_current_dir(dir.join("work")).is_err() {
            unsafe {
                libc::_exit(90);
            }
        }
        let target_mode = match mode.as_str() {
            "direct" | "double" | "signal" | "signal-tree" | "normal" | "high-exit" | "forge"
            | "sandbox" | "cpu" => mode.as_str(),
            "nested" | "proof-truncate" => "normal",
            _ => "hold",
        };
        let target = if mode == "exec-failure" {
            dir.join("absent").to_string_lossy().into_owned()
        } else {
            binary.clone()
        };
        let argv = vec![target, target_mode.to_owned()];
        let fault = match mode.as_str() {
            "clone-failure" => Fault::Clone,
            "pidfd-failure" => Fault::CreatorPidfd,
            "map-failure" => Fault::Mapping,
            "wait-failure" => Fault::Wait,
            "withhold" => Fault::WithholdWait,
            "death-before-registration" => Fault::BeforePdeath,
            "control-error" => Fault::ControlError,
            _ => Fault::None,
        };
        let close = [verifier.as_raw_fd()];
        let options = Options {
            argv: &argv,
            stop: stop_read.as_fd(),
            stdio: [stdin.as_fd(), stdout.as_fd(), stderr.as_fd()],
            wall: Duration::from_millis(if mode == "deadline" || mode == "withhold" {
                180
            } else if mode == "cpu" {
                6000
            } else {
                2000
            }),
            observation: Duration::from_millis(400),
            fault,
            nested_fixture: mode == "nested",
            close_in_init: &close,
        };
        let result = unsafe {
            probe_lifetime::run(
                options,
                || {
                    if mode == "restrict-failure" {
                        return Err("fixture rejection".into());
                    }
                    // The control handles must already be gone during pre-exec setup.
                    for fd in [verifier.as_raw_fd(), stop_read.as_raw_fd()] {
                        if libc::fcntl(fd, libc::F_GETFD) != -1 {
                            return Err("fixture control descriptor retained".into());
                        }
                    }
                    sandbox::apply(&policy)?;
                    limits::apply(&policy::ChildLimits {
                        cpu_seconds: 2,
                        address_space_bytes: 67108864,
                        open_files: 32,
                    })
                },
                |stage, init, deadline| {
                    let byte = match stage {
                        Stage::Registered => b'R',
                        Stage::BeforeRegistration => b'B',
                        Stage::Mapping => b'M',
                        Stage::Gate => b'G',
                        Stage::Admitted => b'T',
                    };
                    if !packet(
                        verifier.as_raw_fd(),
                        byte,
                        if stage == Stage::Registered {
                            Some(init)
                        } else {
                            None
                        },
                    ) {
                        return Err(Failure::Admission);
                    }
                    wait_ack(verifier.as_raw_fd(), deadline)
                },
            )
        };
        let (byte, code) = match result {
            Ok(done) => {
                // Consume the opaque native token. No input/output certificate is parsed.
                let _termination = done.termination;
                let byte = match done.outcome {
                    Outcome::Exited(7) => b'7',
                    Outcome::Exited(200) => b'H',
                    Outcome::Exited(0) => b'0',
                    Outcome::Signalled(libc::SIGTERM) => b'S',
                    Outcome::Signalled(libc::SIGKILL) => b'K',
                    Outcome::Stopped => b'C',
                    Outcome::SetupFailed => b'F',
                    _ => b'X',
                };
                (byte, 0)
            }
            Err(Failure::Unsupported(errno)) => {
                eprintln!("facility-unavailable errno={errno}");
                (b'U', 77)
            }
            Err(Failure::TerminationUnproven) => (b'?', 78),
            Err(error) => {
                eprintln!("fixture admission refused: {error:?}");
                (b'!', 79)
            }
        };
        if mode == "proof-truncate" {
            let bytes = [byte, byte];
            unsafe {
                libc::send(
                    verifier.as_raw_fd(),
                    bytes.as_ptr().cast(),
                    2,
                    libc::MSG_NOSIGNAL | libc::MSG_DONTWAIT,
                );
            }
        } else {
            packet(verifier.as_raw_fd(), byte, None);
        }
        unsafe {
            libc::_exit(code);
        }
    }
    drop(guard_pidfd);
    drop(verifier);
    drop(stop_read);
    drop(stdin);
    drop(stdout);
    drop(stderr);
    let deadline = Instant::now()
        + if mode == "watchdog" {
            Duration::from_millis(180)
        } else {
            Duration::from_secs(8)
        };
    let mut init: Option<OwnedFd> = None;
    let mut result = None;
    let mut admitted = None;
    let mut killed = false;
    let mut verifier_status = None;
    let mut adopted_proof = false;
    let mut stop_write = Some(stop_write);
    // No panicking operations after fork: watchdog continues even if protocol fails.
    while Instant::now() < deadline {
        if let Ok(Some((byte, right))) = recv(guard.as_raw_fd()) {
            match byte {
                b'R' | b'B' | b'M' | b'G' | b'T' => {
                    if byte == b'R' {
                        if init.is_some() || right.is_none() {
                            break;
                        }
                        init = right;
                    } else if right.is_some() {
                        break;
                    }
                    let death = (mode == "death-before-registration" && byte == b'B')
                        || (mode == "death-registration" && byte == b'R')
                        || (mode == "death-mapping" && byte == b'M')
                        || (mode == "death-gate" && byte == b'G');
                    if death {
                        unsafe {
                            libc::kill(pid, libc::SIGKILL);
                        }
                        killed = true;
                    } else if mode == "guard-eof" && byte == b'R' {
                        unsafe {
                            libc::shutdown(guard.as_raw_fd(), libc::SHUT_RDWR);
                        }
                    } else {
                        packet(guard.as_raw_fd(), b'A', None);
                    }
                    if mode == "pre-cancel" && byte == b'R' {
                        if let Some(fd) = &stop_write {
                            packet(fd.as_raw_fd(), b'C', None);
                        }
                    }
                    if byte == b'T' {
                        admitted = Some(Instant::now());
                    }
                }
                _ if right.is_none() => result = Some(byte),
                _ => break,
            }
        }
        if admitted.is_some() && dir.join("work/descendant-ready").exists() && !killed {
            match mode.as_str() {
                "init-kill" => {
                    if let Some(fd) = &init {
                        probe_lifetime::signal_init(fd.as_fd());
                    }
                    killed = true;
                }
                "death-admitted" => {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                    killed = true;
                }
                "cancel" | "output-failure" => {
                    if mode == "output-failure" {
                        // An actual trusted consumer write failure becomes a stop
                        // notification; target stdout never supplies proof.
                        let failure = (|| -> std::io::Result<bool> {
                            let mut chunk = Vec::new();
                            fs::File::open(dir.join("target-out"))?
                                .take(64)
                                .read_to_end(&mut chunk)?;
                            if chunk.is_empty() {
                                return Ok(false);
                            }
                            let mut sink = fs::File::open("/dev/null")?; // deliberately read-only
                            Ok(sink.write_all(&chunk).is_err())
                        })();
                        if !matches!(failure, Ok(true)) {
                            break;
                        }
                    }
                    if let Some(fd) = &stop_write {
                        packet(fd.as_raw_fd(), b'C', None);
                    }
                    killed = true;
                }
                "control-eof" => {
                    stop_write.take();
                    killed = true;
                }
                _ => {}
            }
        }
        if verifier_status.is_none() {
            let mut status = 0;
            let r = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            if r == pid {
                verifier_status = Some(status);
            }
        }
        if verifier_status.is_some() {
            // Drain the final result if wait raced its delivery.
            if let Ok(Some((byte, None))) = recv(guard.as_raw_fd()) {
                result = Some(byte);
            }
            if let Some(fd) = &init {
                if !mode.starts_with("death-") {
                    probe_lifetime::signal_init(fd.as_fd());
                }
                match probe_lifetime::exact_reap(fd.as_fd()) {
                    Ok(Some(_)) => adopted_proof = true,
                    Err(_) if result != Some(b'?') && result != Some(b'!') => break, // no adopted child remains; missing result stays unproven
                    _ => {}
                }
                if adopted_proof {
                    break;
                }
            } else {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    if verifier_status.is_none() {
        if let Some(fd) = &init {
            probe_lifetime::signal_init(fd.as_fd());
        }
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
        // Bounded teardown observation. Never wait() indefinitely on deadline/panic.
        let cleanup = Instant::now() + Duration::from_secs(2);
        while Instant::now() < cleanup {
            let mut status = 0;
            if unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) } == pid {
                verifier_status = Some(status);
            }
            if let Some(fd) = &init {
                if let Ok(Some(_)) = probe_lifetime::exact_reap(fd.as_fd()) {
                    adopted_proof = true;
                }
            }
            if verifier_status.is_some() && (init.is_none() || adopted_proof) {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        eprintln!("watchdog expired; fixture retained");
        if mode == "watchdog" && adopted_proof {
            println!("UNPROVEN retain");
            return ExitCode::from(78);
        }
        return ExitCode::from(80);
    }
    if mode.starts_with("death-") {
        if adopted_proof {
            println!("GUARD-REAP verifier-proof-lost");
            return ExitCode::SUCCESS;
        }
        return ExitCode::from(80);
    }
    match result {
        Some(b'U') => {
            println!("UNAVAILABLE zero-admission");
            ExitCode::from(77)
        }
        None | Some(b'?') => {
            println!("UNPROVEN retain");
            ExitCode::from(78)
        }
        Some(byte @ (b'0' | b'7' | b'H' | b'S' | b'K' | b'C' | b'F')) => {
            println!("PROVEN {}", byte as char);
            ExitCode::SUCCESS
        }
        _ => ExitCode::from(81),
    }
}
