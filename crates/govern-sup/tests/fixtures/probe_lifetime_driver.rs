//! Fresh single-threaded native fixture driver. The outer process is both subreaper
//! and independent wall watchdog; it receives the init pidfd before admission.
#[allow(dead_code)]
#[path = "../../src/limits.rs"]
mod limits;
#[allow(dead_code)]
#[path = "../../src/policy.rs"]
mod policy;
#[allow(dead_code)]
#[path = "../../src/probe_artifact.rs"]
mod probe_artifact;
#[path = "../../src/probe_lifetime.rs"]
mod probe_lifetime;
#[allow(dead_code)]
#[path = "../../src/sandbox.rs"]
mod sandbox;
#[cfg(test)]
#[path = "../../src/supervise.rs"]
mod supervise;
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
#[derive(Debug)]
enum ReceiveFailure {
    End,
    Malformed,
}
fn recv(fd: RawFd) -> Result<Option<(u8, Option<OwnedFd>)>, ReceiveFailure> {
    let mut bytes = [0u8; 2];
    let mut iov = libc::iovec {
        iov_base: bytes.as_mut_ptr().cast(),
        iov_len: 2,
    };
    // Large enough to inspect many rights, then close every installed descriptor
    // even when the payload/control is truncated or more than one FD arrives.
    let mut buffer = [0usize; 64];
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = buffer.as_mut_ptr().cast();
    msg.msg_controllen = std::mem::size_of_val(&buffer);
    let n = unsafe { libc::recvmsg(fd, &mut msg, libc::MSG_DONTWAIT | libc::MSG_CMSG_CLOEXEC) };
    if n < 0
        && matches!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EAGAIN | libc::EINTR)
        )
    {
        return Ok(None);
    }
    let mut rights = Vec::new();
    let mut malformed = false;
    let mut headers = 0;
    let mut header = unsafe { libc::CMSG_FIRSTHDR(&msg) };
    while !header.is_null() {
        headers += 1;
        unsafe {
            if (*header).cmsg_level == libc::SOL_SOCKET
                && (*header).cmsg_type == libc::SCM_RIGHTS
                && (*header).cmsg_len >= libc::CMSG_LEN(0) as usize
            {
                let length = (*header).cmsg_len - libc::CMSG_LEN(0) as usize;
                malformed |= length % std::mem::size_of::<i32>() != 0;
                for i in 0..length / std::mem::size_of::<i32>() {
                    rights.push(OwnedFd::from_raw_fd(
                        libc::CMSG_DATA(header).cast::<i32>().add(i).read(),
                    ));
                }
            } else {
                malformed = true;
            }
            header = libc::CMSG_NXTHDR(&msg, header);
        }
    }
    if n == 0 && rights.is_empty() && headers == 0 {
        return Err(ReceiveFailure::End);
    }
    if n != 1
        || msg.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) != 0
        || malformed
        || headers > 1
        || rights.len() > 1
        || (headers == 1 && rights.len() != 1)
    {
        return Err(ReceiveFailure::Malformed); // all OwnedFd values drop here
    }
    Ok(Some((bytes[0], rights.pop())))
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
// Fixture-local format and exit classifications; never a production certificate.
const TRANSPORT_INVALID: u8 = 64;
const TRANSPORT_UNSUPPORTED: u8 = 65;
const TRANSPORT_ADMISSION: u8 = 66;
const TRANSPORT_UNPROVEN: u8 = 70;
const TRANSPORT_PRODUCER: u8 = 71;

#[derive(Debug)]
struct TransportFailure;

fn frame_header(invocation: [u8; 16], kind: u8, detail: u8, value: u32) -> [u8; 32] {
    let mut frame = [0u8; 32];
    frame[..4].copy_from_slice(b"GPLT");
    frame[4] = 1;
    frame[5] = kind;
    frame[6] = detail;
    frame[8..24].copy_from_slice(&invocation);
    frame[24..28].copy_from_slice(&value.to_be_bytes());
    frame
}
// This private encoder's only authority is consuming actual exact-reap completion.
fn owned_frame(completion: probe_lifetime::ProbeCompletion, invocation: [u8; 16]) -> [u8; 32] {
    let probe_lifetime::ProbeCompletion {
        outcome,
        termination,
    } = completion;
    let _consumed_termination = termination;
    let (detail, value) = match outcome {
        Outcome::Exited(code) => (1, code as u32),
        Outcome::Signalled(signal) => (2, signal as u32),
        Outcome::Stopped => (3, 0),
        Outcome::SetupFailed => (4, 0),
    };
    frame_header(invocation, 1, detail, value)
}
// Failure encoding cannot select the terminated discriminator.
fn failure_frame(failure: Failure, invocation: [u8; 16]) -> ([u8; 32], u8) {
    let (kind, detail, code) = match failure {
        Failure::InvalidInput => (2, 1, TRANSPORT_INVALID),
        Failure::Unsupported(_) => (2, 2, TRANSPORT_UNSUPPORTED),
        Failure::Admission => (2, 3, TRANSPORT_ADMISSION),
        Failure::TerminationUnproven => (3, 1, TRANSPORT_UNPROVEN),
    };
    (frame_header(invocation, kind, detail, 0), code)
}
fn write_bounded(fd: RawFd, bytes: &[u8], deadline: Instant) -> Result<(), TransportFailure> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(TransportFailure);
    }
    let mut offset = 0;
    while offset < bytes.len() && Instant::now() < deadline {
        // Works for Node's socket endpoints and actual FIFOs. Trusted startup ignores
        // SIGPIPE; EPIPE is an ordinary failed emission, never evidence.
        let n = unsafe { libc::write(fd, bytes[offset..].as_ptr().cast(), bytes.len() - offset) };
        if n > 0 {
            offset += n as usize;
        } else {
            match std::io::Error::last_os_error().raw_os_error() {
                Some(libc::EINTR) => continue,
                Some(libc::EAGAIN) => {
                    let mut p = libc::pollfd {
                        fd,
                        events: libc::POLLOUT,
                        revents: 0,
                    };
                    unsafe {
                        libc::poll(&mut p, 1, 2);
                    }
                }
                _ => return Err(TransportFailure),
            }
        }
    }
    if offset == bytes.len() && Instant::now() < deadline {
        Ok(())
    } else {
        Err(TransportFailure)
    }
}
fn write_owned_termination(
    completion: probe_lifetime::ProbeCompletion,
    invocation: [u8; 16],
    proof: OwnedFd,
    deadline: Instant,
) -> Result<(), TransportFailure> {
    let frame = owned_frame(completion, invocation);
    write_bounded(proof.as_raw_fd(), &frame, deadline)
    // OwnedFd closes before the caller sends its private completion indication.
}
// Negative producer injections also consume real completion. They never manufacture
// a native token, and the guard still demands exact clean verifier exit.
fn inject_owned_emission(
    completion: probe_lifetime::ProbeCompletion,
    invocation: [u8; 16],
    proof: OwnedFd,
    deadline: Instant,
    mode: &str,
) -> Result<(), TransportFailure> {
    let mut frame = owned_frame(completion, invocation);
    match mode {
        "death-mid-record" => {
            write_bounded(proof.as_raw_fd(), &frame[..16], deadline)?;
            unsafe {
                libc::raise(libc::SIGKILL);
            }
            Err(TransportFailure)
        }
        "death-full-record" => {
            write_bounded(proof.as_raw_fd(), &frame, deadline)?;
            unsafe {
                libc::raise(libc::SIGKILL);
            }
            Err(TransportFailure)
        }
        "death-closed-record" => {
            write_bounded(proof.as_raw_fd(), &frame, deadline)?;
            drop(proof);
            unsafe {
                libc::raise(libc::SIGKILL);
            }
            Err(TransportFailure)
        }
        "stale-record" | "proof-stale" => {
            frame[8] ^= 1;
            write_bounded(proof.as_raw_fd(), &frame, deadline)
        }
        "extra-record" | "proof-extra" => {
            write_bounded(proof.as_raw_fd(), &frame, deadline)?;
            write_bounded(proof.as_raw_fd(), &frame, deadline)
        }
        "truncated-record" | "proof-truncate" => {
            write_bounded(proof.as_raw_fd(), &frame[..31], deadline)
        }
        "missing-record" | "proof-missing" => Ok(()),
        _ => Err(TransportFailure),
    }
}
fn transport_scenario(mode: &str) -> bool {
    matches!(
        mode,
        "normal"
            | "high-exit"
            | "signal"
            | "direct"
            | "double"
            | "detach"
            | "signal-tree"
            | "hold"
            | "kill-init"
            | "forge"
            | "acp"
            | "acp-forbidden"
            | "acp-hang"
            | "stdout-flood"
            | "stderr-flood"
            | "death-pre-admission"
            | "death-post-admission"
            | "death-mid-record"
            | "death-full-record"
            | "death-closed-record"
            | "stale-record"
            | "extra-record"
            | "truncated-record"
            | "missing-record"
            | "proof-stale"
            | "proof-extra"
            | "proof-truncate"
            | "proof-missing"
            | "guard-eof"
            | "guard-registration-failure"
            | "guard-registration-deadline"
            | "clone-failure"
            | "pidfd-failure"
            | "map-failure"
            | "restrict-failure"
            | "exec-failure"
            | "wait-failure"
            | "withhold"
            | "control-error"
    )
}
fn parse_invocation(value: &str) -> Option<[u8; 16]> {
    if value.len() != 32
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let mut id = [0u8; 16];
    for (i, byte) in id.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(id)
}
fn absent(fd: RawFd) -> bool {
    (unsafe { libc::fcntl(fd, libc::F_GETFD) == -1 })
        && std::io::Error::last_os_error().raw_os_error() == Some(libc::EBADF)
}
fn transport_layout() -> bool {
    let mut identities = Vec::new();
    for fd in 0..=4 {
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(fd, &mut stat) } != 0 {
            return false;
        }
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        let access = flags & libc::O_ACCMODE;
        if flags < 0
            || (matches!(fd, 0 | 3) && access == libc::O_WRONLY)
            || (matches!(fd, 1 | 2 | 4) && access == libc::O_RDONLY)
        {
            return false;
        }
        let kind = stat.st_mode & libc::S_IFMT;
        if kind != libc::S_IFIFO && kind != libc::S_IFSOCK {
            return false;
        }
        if kind == libc::S_IFSOCK {
            let mut value = 0i32;
            let mut len = std::mem::size_of_val(&value) as libc::socklen_t;
            if unsafe {
                libc::getsockopt(
                    fd,
                    libc::SOL_SOCKET,
                    libc::SO_TYPE,
                    (&mut value as *mut i32).cast(),
                    &mut len,
                )
            } != 0
                || value != libc::SOCK_STREAM
            {
                return false;
            }
            let mut address: libc::sockaddr_storage = unsafe { std::mem::zeroed() };
            len = std::mem::size_of_val(&address) as libc::socklen_t;
            if unsafe {
                libc::getsockname(
                    fd,
                    (&mut address as *mut libc::sockaddr_storage).cast(),
                    &mut len,
                )
            } != 0
                || address.ss_family != libc::AF_UNIX as u16
            {
                return false;
            }
        }
        if identities.contains(&(stat.st_dev, stat.st_ino)) {
            return false; // Reject supplied aliases; freshness remains caller precondition.
        }
        identities.push((stat.st_dev, stat.st_ino));
    }
    // Fresh child contract admits no extra descriptors, including duplicate aliases.
    // proc read_dir's own temporary descriptor is the sole additional descriptor.
    let Ok(entries) = fs::read_dir("/proc/self/fd") else {
        return false;
    };
    let mut extra = 0;
    for entry in entries {
        let Ok(entry) = entry else {
            return false;
        };
        let Some(fd) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<i32>().ok())
        else {
            return false;
        };
        if fd > 4 {
            extra += 1;
        }
    }
    extra == 1
}

// Only this finite bound mode can consume a selected image completion. Pathname
// completion never becomes a bound completion, even when identifiers match.
enum DriverCompletion {
    Path(probe_lifetime::ProbeCompletion),
    Bound(probe_lifetime::BoundProbeCompletion),
}
fn write_bound_termination(
    completion: probe_lifetime::BoundProbeCompletion,
    invocation: [u8; 16],
    proof: OwnedFd,
    deadline: Instant,
) -> Result<(), TransportFailure> {
    let completion = completion
        .into_completion(invocation)
        .map_err(|_| TransportFailure)?;
    write_owned_termination(completion, invocation, proof, deadline)
}
fn write_driver_termination(
    completion: DriverCompletion,
    invocation: [u8; 16],
    proof: OwnedFd,
    deadline: Instant,
) -> Result<(), TransportFailure> {
    match completion {
        DriverCompletion::Path(c) => write_owned_termination(c, invocation, proof, deadline),
        DriverCompletion::Bound(c) => write_bound_termination(c, invocation, proof, deadline),
    }
}
fn inject_driver_emission(
    completion: DriverCompletion,
    invocation: [u8; 16],
    proof: OwnedFd,
    deadline: Instant,
    mode: &str,
) -> Result<(), TransportFailure> {
    let c = match completion {
        DriverCompletion::Path(c) => c,
        DriverCompletion::Bound(c) => c
            .into_completion(invocation)
            .map_err(|_| TransportFailure)?,
    };
    inject_owned_emission(c, invocation, proof, deadline, mode)
}
fn bound_scenario(mode: &str) -> bool {
    matches!(
        mode,
        "sandbox"
            | "sealed-replace"
            | "sealed-mutate"
            | "before-copy-b"
            | "copy-torn"
            | "copy-truncate"
            | "copy-grow"
            | "copy-b"
            | "image-mismatch"
            | "prep-expired"
            | "prep-entry-expired"
            | "prep-validation-expired"
            | "prep-gate-expired"
            | "prep-release-expired"
            | "prep-exec-expired"
            | "prep-gate-expired-unproven"
            | "prep-stop"
            | "fault-open"
            | "fault-read"
            | "fault-write"
            | "fault-seal"
            | "fault-readback"
            | "fault-compare"
            | "fault-mode"
            | "fault-close"
            | "seal-aliases"
            | "writable-map"
            | "fault-dup"
            | "fault-close-range"
            | "fault-inventory"
            | "fault-exec"
            | "limits-failure"
    )
}
fn real_sealed_alias_checks(image: BorrowedFd<'_>) -> bool {
    // Exercise a real alias of the sealed object, then close and check it. Seals
    // govern the shared inode, rather than granting authority to a raw fd number.
    let alias = unsafe { libc::fcntl(image.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 20) };
    if alias < 0 {
        return false;
    }
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    let mut ok = unsafe { libc::fstat(alias, &mut stat) == 0 };
    let byte = [0u8; 1];
    ok &= unsafe { libc::pwrite(alias, byte.as_ptr().cast(), 1, 0) == -1 };
    ok &= unsafe { libc::ftruncate(alias, stat.st_size + 1) == -1 };
    ok &= unsafe { libc::ftruncate(alias, stat.st_size - 1) == -1 };
    ok &= unsafe {
        libc::fallocate(
            alias,
            libc::FALLOC_FL_PUNCH_HOLE | libc::FALLOC_FL_KEEP_SIZE,
            0,
            4096,
        ) == -1
    };
    let memory = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            4096,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_SHARED,
            alias,
            0,
        )
    };
    ok &= memory == libc::MAP_FAILED;
    if memory != libc::MAP_FAILED {
        unsafe {
            libc::munmap(memory, 4096);
        }
    }
    ok &= unsafe { libc::fchmod(alias, 0o777) == -1 };
    unsafe {
        libc::close(alias);
    }
    ok && absent(alias)
}
fn bound_run<R: FnOnce() -> Result<(), String>>(
    options: Options<'_>,
    source: &Path,
    invocation: [u8; 16],
    mode: &str,
    restrict: R,
    observer: impl FnMut(Stage, BorrowedFd<'_>, Instant) -> Result<(), Failure>,
) -> Result<DriverCompletion, Failure> {
    use probe_artifact::{FixtureImageFault as ImageFault, FixtureImageStage as ImageStage};
    if !probe_artifact::fixture_available() {
        return Err(Failure::Unsupported(libc::ENOSYS));
    }
    if mode == "before-copy-b" {
        fs::write(source, probe_artifact::EMBEDDED_B).map_err(|_| Failure::Admission)?;
    }
    if mode == "prep-stop" {
        unsafe {
            libc::shutdown(options.stop.as_raw_fd(), libc::SHUT_RDWR);
        }
    }
    let deadline = if mode == "prep-expired" {
        Instant::now()
    } else if matches!(mode, "prep-release-expired" | "prep-exec-expired") {
        // Fixed failure-only fixtures separate child-side preparation expiry
        // from the independent two-second run-wall stop. Never renew either.
        Instant::now() + Duration::from_secs(1)
    } else {
        Instant::now() + Duration::from_secs(2)
    };
    let image_fault = match mode {
        "fault-open" => ImageFault::Open,
        "fault-read" => ImageFault::Read,
        "fault-write" => ImageFault::Write,
        "fault-seal" => ImageFault::Seal,
        "fault-readback" => ImageFault::Readback,
        "fault-compare" => ImageFault::Compare,
        "fault-mode" => ImageFault::Mode,
        "fault-close" => ImageFault::Close,
        _ => ImageFault::None,
    };
    let mut mapped = std::ptr::null_mut();
    let mut changed = false;
    let result = probe_artifact::prepare_fixture_image_observed(
        source,
        invocation,
        deadline,
        options.stop,
        image_fault,
        |stage, image, _deadline| {
            let operation = (|| -> Result<(), std::io::Error> {
                if stage == ImageStage::CopyChunk && !changed && mode.starts_with("copy-") {
                    changed = true;
                    match mode {
                        "copy-truncate" => fs::OpenOptions::new()
                            .write(true)
                            .open(source)?
                            .set_len(64)?,
                        "copy-grow" => fs::OpenOptions::new()
                            .write(true)
                            .open(source)?
                            .set_len(probe_artifact::EMBEDDED_A.len() as u64 + 1)?,
                        "copy-b" => fs::write(source, probe_artifact::EMBEDDED_B)?,
                        "copy-torn" => {
                            use std::os::unix::fs::FileExt;
                            let file = fs::OpenOptions::new().write(true).open(source)?;
                            file.write_all_at(&[0xa5; 4096], 4096)?;
                        }
                        _ => {}
                    }
                }
                if stage == ImageStage::BeforeSeal && mode == "writable-map" {
                    mapped = unsafe {
                        libc::mmap(
                            std::ptr::null_mut(),
                            4096,
                            libc::PROT_READ | libc::PROT_WRITE,
                            libc::MAP_SHARED,
                            image.as_raw_fd(),
                            0,
                        )
                    };
                    if mapped == libc::MAP_FAILED {
                        return Err(std::io::Error::other("fixture writable map failed"));
                    }
                }
                if stage == ImageStage::Sealed && mode == "seal-aliases" {
                    if !real_sealed_alias_checks(image) {
                        return Err(std::io::Error::other("fixture seal enforcement failed"));
                    }
                    fs::write(
                        "sealed-aliases-ok",
                        b"real sealed alias operations refused\n",
                    )?;
                }
                if stage == ImageStage::Compared
                    && matches!(mode, "sealed-replace" | "sealed-mutate")
                {
                    if mode == "sealed-replace" {
                        use std::os::unix::fs::PermissionsExt;
                        let replacement = source.with_extension("replacement");
                        fs::write(&replacement, probe_artifact::EMBEDDED_B)?;
                        fs::set_permissions(&replacement, fs::Permissions::from_mode(0o700))?;
                        fs::rename(replacement, source)?;
                    } else {
                        fs::write(source, probe_artifact::EMBEDDED_B)?;
                    }
                }
                Ok(())
            })();
            operation.map_err(|_| probe_artifact::FixtureImageFailure::Source)
        },
    );
    if !mapped.is_null() && mapped != libc::MAP_FAILED {
        unsafe {
            libc::munmap(mapped, 4096);
        }
    }
    let image = result.map_err(|failure| match failure {
        probe_artifact::FixtureImageFailure::Unavailable => Failure::Unsupported(libc::ENOSYS),
        _ => Failure::Admission,
    })?;
    let mut id = invocation;
    if mode == "image-mismatch" {
        id[0] ^= 1;
    }
    let fault = match mode {
        "prep-entry-expired" => probe_lifetime::BoundExecutionFault::EntryDeadline,
        "prep-validation-expired" => probe_lifetime::BoundExecutionFault::PreCloneDeadline,
        "prep-gate-expired" | "prep-gate-expired-unproven" => {
            probe_lifetime::BoundExecutionFault::GateDeadline
        }
        "prep-release-expired" => probe_lifetime::BoundExecutionFault::ReleaseDeadline,
        "prep-exec-expired" => probe_lifetime::BoundExecutionFault::ExecDeadline,
        "fault-dup" => probe_lifetime::BoundExecutionFault::Dup,
        "fault-close-range" => probe_lifetime::BoundExecutionFault::CloseRange,
        "fault-inventory" => probe_lifetime::BoundExecutionFault::Inventory,
        "fault-exec" | "exec-failure" => probe_lifetime::BoundExecutionFault::Exec,
        _ => probe_lifetime::BoundExecutionFault::None,
    };
    let completion = if fault == probe_lifetime::BoundExecutionFault::None {
        unsafe { probe_lifetime::run_bound(options, image, id, restrict, observer) }
    } else {
        unsafe { probe_lifetime::run_bound_fault(options, image, id, restrict, observer, fault) }
    };
    completion.map(DriverCompletion::Bound)
}
fn transport_mode(args: &[String]) -> ExitCode {
    let bound = args.get(1).is_some_and(|s| s == "bound-transport-v1");
    if unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) } == libc::SIG_ERR {
        return ExitCode::from(TRANSPORT_PRODUCER);
    }
    let Some(invocation) = args.get(6).and_then(|s| parse_invocation(s)) else {
        return ExitCode::from(TRANSPORT_INVALID);
    };
    let reject = |failure| {
        let (frame, code) = failure_frame(failure, invocation);
        // Invalid descriptor layouts execute zero targets; failed emission is unproven.
        let _ = write_bounded(4, &frame, Instant::now() + Duration::from_millis(250));
        ExitCode::from(code)
    };
    if args.len() != 7
        || !(transport_scenario(&args[3]) || (bound && bound_scenario(&args[3])))
        || [&args[2], &args[4], &args[5]]
            .iter()
            .any(|s| !Path::new(s).is_absolute() || s.contains('\0'))
        || !transport_layout()
    {
        return reject(Failure::InvalidInput);
    }
    if unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) } == libc::SIG_ERR {
        return reject(Failure::Admission);
    }
    let supplied_policy = if bound {
        Ok(
            serde_json::json!({"version":1,"read":[],"write":[args[4]],"exec":[],
            "tcp_connect":[],"tcp_bind":[],"unix_connect":[],"cwd":args[4],
            "child_restrictions":{"deny_network":true,"deny_chmod":true}})
            .to_string(),
        )
    } else {
        policy::read_bounded(Path::new(&args[5]))
    };
    let policy_text = match supplied_policy {
        Ok(p) => p,
        Err(_) => return reject(Failure::InvalidInput),
    };
    // Bound policy path handles are opened only inside the trusted restriction
    // callback, after the exact pre-restriction inventory. No inherited keep-list.
    let policy = if bound {
        None
    } else {
        match policy::parse(&policy_text) {
            Ok(p) => Some(p),
            Err(_) => return reject(Failure::InvalidInput),
        }
    };
    let mode = args[3].as_str();
    let cwd = Path::new(&args[4]);
    if !clear_inherited_capabilities()
        || fs::read_dir("/proc/self/task").map(|v| v.count()).ok() != Some(1)
        || unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0
    {
        return reject(Failure::Admission);
    }
    // Complete descriptor inventory before fork: original stdio 0..2, stop3,
    // proof4; exactly three stdio duplicates >=10; private pair; creator guard
    // pidfd. In the verifier, one temporary /dev/null FD replaces original 0..2
    // and is dropped before run. No proof/control aliases are created. The guard ACK is issued only once all
    // of its stdio/control/proof copies and duplicates have been closed+checked.
    let mut duplicates = Vec::new();
    for fd in 0..3 {
        let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
        if duplicate < 0 {
            return reject(Failure::InvalidInput);
        }
        duplicates.push(unsafe { OwnedFd::from_raw_fd(duplicate) });
    }
    let [guard, verifier] = pair();
    let guard_pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) } as i32;
    if guard_pidfd < 0 {
        return reject(Failure::Unsupported(
            std::io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or(libc::ENOSYS),
        ));
    }
    let guard_pidfd = unsafe { OwnedFd::from_raw_fd(guard_pidfd) };
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return reject(Failure::Admission);
    }
    if pid == 0 {
        if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) } != 0 {
            unsafe {
                libc::_exit(TRANSPORT_PRODUCER as i32);
            }
        }
        let mut p = libc::pollfd {
            fd: guard_pidfd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        if unsafe { libc::poll(&mut p, 1, 0) } != 0 {
            unsafe {
                libc::_exit(TRANSPORT_PRODUCER as i32);
            }
        }
        drop(guard_pidfd);
        drop(guard);
        if std::env::set_current_dir(cwd).is_err() {
            unsafe {
                libc::_exit(TRANSPORT_PRODUCER as i32);
            }
        }
        // Remove the verifier's original ACP aliases before namespace creation.
        // Keep 0..2 occupied with inert /dev/null handles so the primitive's
        // private gate/creator handles cannot allocate reserved stdio numbers.
        // Its existing close_in_init contract correctly rejects descriptors <3.
        let null = match fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/null")
        {
            Ok(fd) => fd,
            Err(_) => unsafe { libc::_exit(TRANSPORT_PRODUCER as i32) },
        };
        for fd in 0..3 {
            if unsafe { libc::dup2(null.as_raw_fd(), fd) } != fd {
                unsafe {
                    libc::_exit(TRANSPORT_PRODUCER as i32);
                }
            }
        }
        drop(null);
        let stop = unsafe { OwnedFd::from_raw_fd(3) };
        let proof = unsafe { OwnedFd::from_raw_fd(4) };
        let target_mode = match mode {
            "normal" | "high-exit" | "signal" | "direct" | "double" | "detach" | "signal-tree"
            | "sandbox" | "forge" | "acp" | "acp-forbidden" | "acp-hang" | "stdout-flood"
            | "stderr-flood" => mode,
            "kill-init"
            | "death-post-admission"
            | "control-error"
            | "wait-failure"
            | "withhold" => "hold",
            _ if mode.starts_with("death-")
                || mode.contains("record")
                || mode.starts_with("proof-") =>
            {
                "normal"
            }
            _ if bound && bound_scenario(mode) => "normal",
            _ => "hold",
        };
        let target = if mode == "exec-failure" {
            cwd.join("absent").to_string_lossy().into_owned()
        } else {
            args[2].clone()
        };
        let argv = vec![target, target_mode.into(), args[6].clone()];
        let fault = match mode {
            "clone-failure" => Fault::Clone,
            "pidfd-failure" => Fault::CreatorPidfd,
            "map-failure" => Fault::Mapping,
            "wait-failure" | "prep-gate-expired-unproven" => Fault::Wait,
            "withhold" => Fault::WithholdWait,
            "control-error" => Fault::ControlError,
            _ => Fault::None,
        };
        // Original ACP aliases are already gone. PID1 closes proof and guard
        // BEFORE target fork. Target closes stop/gate/creator BEFORE restriction;
        // native's checked close_range then removes its high stdio duplicates.
        let close = [proof.as_raw_fd(), verifier.as_raw_fd()];
        let options = Options {
            argv: &argv,
            stop: stop.as_fd(),
            stdio: [
                duplicates[0].as_fd(),
                duplicates[1].as_fd(),
                duplicates[2].as_fd(),
            ],
            wall: Duration::from_millis(2000),
            observation: Duration::from_millis(400),
            fault,
            nested_fixture: false,
            close_in_init: &close,
        };
        let restrict = || {
            for fd in [proof.as_raw_fd(), verifier.as_raw_fd()] {
                if !absent(fd) {
                    return Err("fixture descriptor retained before restriction".into());
                }
            }
            if !bound && !absent(stop.as_raw_fd()) {
                return Err("fixture stop retained before restriction".into());
            }
            if mode == "restrict-failure" {
                return Err("fixture restriction failure".into());
            }
            let bound_policy = if bound {
                Some(policy::parse(&policy_text)?)
            } else {
                None
            };
            sandbox::apply(bound_policy.as_ref().or(policy.as_ref()).unwrap())?;
            if mode == "limits-failure" {
                return Err("fixture limit failure".into());
            }
            limits::apply(&policy::ChildLimits {
                cpu_seconds: 2,
                address_space_bytes: 67108864,
                open_files: 32,
            })?;
            fs::write(
                "pre-restriction-fds",
                if bound {
                    b"owned sealed image fd3; controls closed\n".as_slice()
                } else {
                    b"EBADF before restriction\n".as_slice()
                },
            )
            .map_err(|e| e.to_string())
        };
        let observer = |stage, init: BorrowedFd<'_>, deadline| {
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
        };
        let result = if bound {
            bound_run(
                options,
                Path::new(&args[2]),
                invocation,
                mode,
                restrict,
                observer,
            )
        } else {
            unsafe { probe_lifetime::run(options, restrict, observer) }.map(DriverCompletion::Path)
        };

        // Verifier has no ACP alias during terminal emission. PID1 and target are
        // already reaped on Ok; failures remain governed by the outer pidfd guard.
        drop(duplicates);
        for fd in 0..3 {
            unsafe {
                libc::close(fd);
            }
        }
        drop(stop);
        let deadline = Instant::now() + Duration::from_millis(250);
        let (emitted, code) = match result {
            Ok(completion)
                if matches!(
                    mode,
                    "death-mid-record"
                        | "death-full-record"
                        | "death-closed-record"
                        | "stale-record"
                        | "extra-record"
                        | "truncated-record"
                        | "missing-record"
                        | "proof-stale"
                        | "proof-extra"
                        | "proof-truncate"
                        | "proof-missing"
                ) =>
            {
                (
                    inject_driver_emission(completion, invocation, proof, deadline, mode),
                    0,
                )
            }
            Ok(completion) => (
                write_driver_termination(completion, invocation, proof, deadline),
                0,
            ),
            Err(failure) => {
                let (frame, code) = failure_frame(failure, invocation);
                let result = write_bounded(proof.as_raw_fd(), &frame, deadline);
                drop(proof);
                (result, code)
            }
        };
        let byte = match code {
            0 => b'D',
            TRANSPORT_INVALID => b'I',
            TRANSPORT_UNSUPPORTED => b'U',
            TRANSPORT_ADMISSION => b'J',
            TRANSPORT_UNPROVEN => b'?',
            _ => b'X',
        };
        let exit = if emitted.is_ok() && packet(verifier.as_raw_fd(), byte, None) {
            code
        } else {
            TRANSPORT_PRODUCER
        };
        unsafe {
            libc::_exit(exit as i32);
        }
    }
    drop(guard_pidfd);
    drop(verifier);
    let duplicate_numbers: Vec<_> = duplicates.iter().map(AsRawFd::as_raw_fd).collect();
    drop(duplicates);
    let mut closed = duplicate_numbers.iter().all(|fd| absent(*fd));
    for fd in 0..=4 {
        unsafe {
            libc::close(fd);
        }
        closed &= absent(fd);
    }
    // Even failure to close denies ACK/admission. The watchdog remains independent.
    transport_guard(pid, guard, closed, mode, cwd)
}
fn transport_guard(pid: i32, guard: OwnedFd, closed: bool, mode: &str, cwd: &Path) -> ExitCode {
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut init: Option<OwnedFd> = None;
    let mut terminal = None;
    let mut status = None;
    let mut stage = 0;
    let mut admitted = false;
    let mut poisoned = !closed;
    let mut injected = false;
    let mut adopted = false;
    let mut channel_ended = false;
    loop {
        match recv(guard.as_raw_fd()) {
            Ok(Some((byte, right))) => {
                let expected = match stage {
                    0 => b'R',
                    1 => b'M',
                    2 => b'G',
                    3 => b'T',
                    _ => 0,
                };
                if byte == expected && terminal.is_none() && !poisoned {
                    if byte == b'R' {
                        if right.is_none() || init.is_some() {
                            poisoned = true;
                        } else {
                            init = right;
                        }
                    } else if right.is_some() {
                        poisoned = true;
                    }
                    if mode == "guard-registration-failure" && byte == b'R' {
                        poisoned = true;
                    }
                    if mode == "guard-eof" && byte == b'R' {
                        unsafe {
                            libc::shutdown(guard.as_raw_fd(), libc::SHUT_RDWR);
                        }
                        poisoned = true;
                    }
                    if mode == "death-pre-admission" && byte == b'G' {
                        unsafe {
                            libc::kill(pid, libc::SIGKILL);
                        }
                        injected = true;
                        poisoned = true;
                    }
                    if !poisoned {
                        stage += 1;
                        if !(mode == "guard-registration-deadline" && byte == b'R')
                            && !packet(guard.as_raw_fd(), b'A', None)
                        {
                            poisoned = true;
                        }
                        admitted |= byte == b'T';
                    }
                } else if right.is_none()
                    && terminal.is_none()
                    && matches!(byte, b'D' | b'I' | b'U' | b'J' | b'?')
                {
                    terminal = Some(byte);
                } else {
                    poisoned = true;
                }
            }
            Ok(None) => {}
            Err(ReceiveFailure::End) => {
                channel_ended = true;
            }
            Err(ReceiveFailure::Malformed) => {
                poisoned = true;
            }
        }
        if admitted && !injected && cwd.join("descendant-ready").exists() {
            match mode {
                "kill-init" => {
                    if let Some(fd) = &init {
                        probe_lifetime::signal_init(fd.as_fd());
                    }
                    injected = true;
                }
                "death-post-admission" => {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                    injected = true;
                    poisoned = true;
                }
                _ => {}
            }
        }
        if poisoned {
            if let Some(fd) = &init {
                probe_lifetime::signal_init(fd.as_fd());
            }
        }
        if status.is_none() {
            let mut exact = 0;
            let r = unsafe { libc::waitpid(pid, &mut exact, libc::WNOHANG) };
            if r == pid {
                status = Some(exact);
            }
        }
        if status.is_some() && channel_ended {
            break;
        }
        if Instant::now() >= deadline {
            poisoned = true;
            if let Some(fd) = &init {
                probe_lifetime::signal_init(fd.as_fd());
            }
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    // Adopted init reaping is fixture safety ONLY. Never repair a missing producer
    // record/private completion or a killed verifier. Always bounded, never wait().
    let cleanup = Instant::now() + Duration::from_secs(2);
    while Instant::now() < cleanup {
        if status.is_none() {
            let mut exact = 0;
            if unsafe { libc::waitpid(pid, &mut exact, libc::WNOHANG) } == pid {
                status = Some(exact);
            }
        }
        if let Some(fd) = &init {
            if poisoned || status.is_some_and(|s| !libc::WIFEXITED(s) || libc::WEXITSTATUS(s) != 0)
            {
                probe_lifetime::signal_init(fd.as_fd());
            }
            match probe_lifetime::exact_reap(fd.as_fd()) {
                Ok(Some(_)) => {
                    adopted = true;
                }
                Err(_) if status.is_some() => {
                    break;
                } // verifier may have already reaped
                _ => {}
            }
        }
        if status.is_some() && (init.is_none() || adopted) {
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    if poisoned || !channel_ended {
        return ExitCode::from(TRANSPORT_PRODUCER);
    }
    let Some(exact) = status else {
        return ExitCode::from(TRANSPORT_PRODUCER);
    };
    if !libc::WIFEXITED(exact) {
        return ExitCode::from(TRANSPORT_PRODUCER);
    }
    let expected = match terminal {
        Some(b'D') if init.is_some() => 0,
        Some(b'I') if init.is_none() => TRANSPORT_INVALID,
        Some(b'U') if init.is_none() => TRANSPORT_UNSUPPORTED,
        Some(b'J') if init.is_none() => TRANSPORT_ADMISSION,
        Some(b'?') => TRANSPORT_UNPROVEN,
        _ => TRANSPORT_PRODUCER,
    };
    if expected == TRANSPORT_PRODUCER || libc::WEXITSTATUS(exact) != expected as i32 {
        ExitCode::from(TRANSPORT_PRODUCER)
    } else {
        ExitCode::from(expected)
    }
}

fn main() -> ExitCode {
    let transport_args: Vec<String> = std::env::args().collect();
    if let Some(mode) = transport_args.get(1) {
        if matches!(mode.as_str(), "fixture-image-a" | "fixture-image-b") {
            if transport_args.len() != 2 || !probe_artifact::fixture_available() {
                return ExitCode::from(TRANSPORT_UNSUPPORTED);
            }
            let bytes = if mode == "fixture-image-a" {
                probe_artifact::EMBEDDED_A
            } else {
                probe_artifact::EMBEDDED_B
            };
            if !(64..=4 * 1024 * 1024).contains(&bytes.len()) {
                return ExitCode::from(TRANSPORT_UNSUPPORTED);
            }
            return if write_bounded(1, bytes, Instant::now() + Duration::from_secs(2)).is_ok() {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(TRANSPORT_PRODUCER)
            };
        }
    }
    if transport_args
        .get(1)
        .is_some_and(|s| matches!(s.as_str(), "transport-v1" | "bound-transport-v1"))
    {
        return transport_mode(&transport_args);
    }
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

#[cfg(test)]
mod transport_tests {
    use super::*;

    fn fd_count() -> usize {
        fs::read_dir("/proc/self/fd").unwrap().count()
    }
    fn malformed_rights(fd: RawFd, rights: &[RawFd], bytes: &[u8]) {
        let mut buffer = vec![
            0usize;
            (unsafe { libc::CMSG_SPACE(std::mem::size_of_val(rights) as u32) }
                as usize)
                .div_ceil(std::mem::size_of::<usize>())
        ];
        let mut iov = libc::iovec {
            iov_base: bytes.as_ptr() as *mut libc::c_void,
            iov_len: bytes.len(),
        };
        let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = buffer.as_mut_ptr().cast();
        msg.msg_controllen = std::mem::size_of_val(buffer.as_slice());
        unsafe {
            let header = libc::CMSG_FIRSTHDR(&msg);
            (*header).cmsg_level = libc::SOL_SOCKET;
            (*header).cmsg_type = libc::SCM_RIGHTS;
            (*header).cmsg_len = libc::CMSG_LEN(std::mem::size_of_val(rights) as u32) as usize;
            std::ptr::copy_nonoverlapping(
                rights.as_ptr(),
                libc::CMSG_DATA(header).cast(),
                rights.len(),
            );
            assert_eq!(
                libc::sendmsg(fd, &msg, libc::MSG_NOSIGNAL),
                bytes.len() as isize
            );
        }
    }
    #[test]
    fn ancillary_rejection_closes_all_received_descriptors() {
        // Descriptor counts belong to the whole process. Run this check alone in
        // a fresh test process so parallel tests cannot open/close unrelated FDs.
        const CHILD: &str = "GS_ANCILLARY_CHECK_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "transport_tests::ancillary_rejection_closes_all_received_descriptors",
                    "--nocapture",
                ])
                .env_clear()
                .env(CHILD, "1")
                .spawn()
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(status.success(), "isolated descriptor check failed");
                    return;
                }
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    panic!("isolated descriptor check exceeded its watchdog");
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        }
        let [sender, receiver] = pair();
        let right = fs::File::open("/dev/null").unwrap();
        for (count, bytes) in [
            (2, b"R".as_slice()),
            (1, b"RR".as_slice()),
            (160, b"R".as_slice()),
            (1, b"".as_slice()),
        ] {
            let before = fd_count();
            malformed_rights(sender.as_raw_fd(), &vec![right.as_raw_fd(); count], bytes);
            assert!(matches!(
                recv(receiver.as_raw_fd()),
                Err(ReceiveFailure::Malformed)
            ));
            assert_eq!(
                fd_count(),
                before,
                "every installed FD must close on rejection"
            );
        }
        assert!(packet(sender.as_raw_fd(), b'R', Some(right.as_fd())));
        let before = fd_count();
        let Ok(Some((b'R', Some(received)))) = recv(receiver.as_raw_fd()) else {
            panic!("valid registration");
        };
        assert_eq!(fd_count(), before + 1);
        drop(received);
        assert_eq!(fd_count(), before);
        // Unexpected credentials plus a right must reject AND close the right.
        let pass = 1i32;
        assert_eq!(
            unsafe {
                libc::setsockopt(
                    receiver.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_PASSCRED,
                    (&pass as *const i32).cast(),
                    std::mem::size_of_val(&pass) as u32,
                )
            },
            0
        );
        assert!(packet(sender.as_raw_fd(), b'R', Some(right.as_fd())));
        assert!(matches!(
            recv(receiver.as_raw_fd()),
            Err(ReceiveFailure::Malformed)
        ));
        assert_eq!(fd_count(), before);
    }
    #[test]
    fn bounded_writer_handles_real_stream_backpressure_and_peer_closure() {
        let [a, b] = {
            let mut fds = [-1; 2];
            assert_eq!(
                unsafe {
                    libc::socketpair(
                        libc::AF_UNIX,
                        libc::SOCK_STREAM | libc::SOCK_CLOEXEC,
                        0,
                        fds.as_mut_ptr(),
                    )
                },
                0
            );
            fds.map(|fd| unsafe { OwnedFd::from_raw_fd(fd) })
        };
        unsafe {
            libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        }
        let start = Instant::now();
        assert!(
            write_bounded(
                a.as_raw_fd(),
                &[0; 1_000_000],
                start + Duration::from_millis(30)
            )
            .is_err()
        );
        assert!(start.elapsed() < Duration::from_secs(1));
        drop(b);
        assert!(
            write_bounded(
                a.as_raw_fd(),
                b"closed",
                Instant::now() + Duration::from_millis(30)
            )
            .is_err()
        );
    }
}
