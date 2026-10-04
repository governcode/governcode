//! Feature-only fixed-image admission. The owned sealed inode, rather than its
//! source pathname or a caller assertion, is the initial execution capability.
use std::ffi::CString;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::time::{Duration, Instant};

pub(crate) const EMBEDDED_A: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/probe_fixture_a"));
pub(crate) const EMBEDDED_B: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/probe_fixture_b"));
const MAX_IMAGE: usize = 4 * 1024 * 1024;
const CHUNK: usize = 16 * 1024;
const SEAL_EXEC: i32 = 0x0020;
const REQUIRED_SEALS: i32 =
    libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | SEAL_EXEC | libc::F_SEAL_SEAL;

#[derive(Debug)]
pub(crate) struct VerifiedFixtureImage {
    fd: OwnedFd,
    invocation: [u8; 16],
    preparation_deadline: Instant,
}
impl VerifiedFixtureImage {
    pub(crate) fn as_fd(&self) -> BorrowedFd<'_> {
        self.fd.as_fd()
    }
    pub(crate) fn as_raw_fd(&self) -> RawFd {
        self.fd.as_raw_fd()
    }
    pub(crate) fn matches_invocation(&self, invocation: [u8; 16]) -> bool {
        self.invocation == invocation
    }
    pub(crate) fn preparation_deadline(&self) -> Instant {
        self.preparation_deadline
    }
}

// Failure-only injection. Observers may attempt actual mutations, but neither
// seam can bypass sealing, ELF validation, comparison, or the final time check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FixtureImageFault {
    None,
    Open,
    Read,
    Write,
    Mode,
    Seal,
    Readback,
    Compare,
    Close,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FixtureImageStage {
    CopyChunk,
    BeforeSeal,
    Sealed,
    Compared,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FixtureImageFailure {
    Unavailable,
    InvalidInput,
    Source,
    NoExec,
    Copy,
    Mode,
    Seal,
    Readback,
    Elf,
    Compare,
    Close,
    Stopped,
    Deadline,
}

pub(crate) fn fixture_available() -> bool {
    cfg!(all(
        target_os = "linux",
        target_arch = "x86_64",
        target_endian = "little"
    )) && env!("PROBE_FIXTURE_BUILD_AVAILABLE") == "1"
        && unsafe { libc::sysconf(libc::_SC_PAGESIZE) } == 4096
        && validate_elf(EMBEDDED_A).is_ok()
        && validate_elf(EMBEDDED_B).is_ok()
        && EMBEDDED_A != EMBEDDED_B
}

fn checkpoint(stop: BorrowedFd<'_>, deadline: Instant) -> Result<(), FixtureImageFailure> {
    if Instant::now() >= deadline {
        return Err(FixtureImageFailure::Deadline);
    }
    let mut pfd = libc::pollfd {
        fd: stop.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    let result = unsafe { libc::poll(&mut pfd, 1, 0) };
    if result != 0 {
        // Data, EOF, HUP, invalid descriptors and poll errors all close admission.
        return Err(FixtureImageFailure::Stopped);
    }
    Ok(())
}
fn stat(fd: BorrowedFd<'_>) -> Result<libc::stat, FixtureImageFailure> {
    let mut result = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd.as_raw_fd(), &mut result) } != 0 {
        return Err(FixtureImageFailure::Source);
    }
    Ok(result)
}
fn source_valid(s: &libc::stat) -> bool {
    s.st_mode & libc::S_IFMT == libc::S_IFREG
        && s.st_uid == unsafe { libc::geteuid() }
        && s.st_nlink == 1
        && s.st_mode & 0o7777 == 0o700
        && (64..=MAX_IMAGE as i64).contains(&s.st_size)
}
fn image_valid(s: &libc::stat) -> bool {
    s.st_mode & libc::S_IFMT == libc::S_IFREG
        && s.st_uid == unsafe { libc::geteuid() }
        && s.st_nlink == 0
        && s.st_mode & 0o7777 == 0o700
        && (64..=MAX_IMAGE as i64).contains(&s.st_size)
}
fn unchanged(a: &libc::stat, b: &libc::stat) -> bool {
    source_valid(b)
        && a.st_dev == b.st_dev
        && a.st_ino == b.st_ino
        && a.st_size == b.st_size
        && a.st_uid == b.st_uid
        && a.st_gid == b.st_gid
        && a.st_mode == b.st_mode
        && a.st_nlink == b.st_nlink
        && a.st_mtime == b.st_mtime
        && a.st_mtime_nsec == b.st_mtime_nsec
        && a.st_ctime == b.st_ctime
        && a.st_ctime_nsec == b.st_ctime_nsec
}
fn close_checked(fd: OwnedFd) -> Result<(), FixtureImageFailure> {
    // Linux releases the descriptor even on close errors; never retry a recycled
    // integer. Every owned handle is either checked here or dropped on refusal.
    if unsafe { libc::close(fd.into_raw_fd()) } != 0 {
        return Err(FixtureImageFailure::Close);
    }
    Ok(())
}
fn open_source(path: &Path) -> Result<(OwnedFd, OwnedFd), FixtureImageFailure> {
    if path.as_os_str().as_bytes().len() > 3072 {
        return Err(FixtureImageFailure::InvalidInput);
    }
    let (base, relative) = if path.is_absolute() {
        (
            c"/",
            path.strip_prefix("/")
                .map_err(|_| FixtureImageFailure::InvalidInput)?,
        )
    } else {
        (c".", path)
    };
    let name = CString::new(relative.as_os_str().as_bytes())
        .map_err(|_| FixtureImageFailure::InvalidInput)?;
    if name.as_bytes().is_empty() {
        return Err(FixtureImageFailure::InvalidInput);
    }
    let raw = unsafe {
        libc::open(
            base.as_ptr(),
            libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if raw < 0 {
        return Err(FixtureImageFailure::Source);
    }
    let directory = unsafe { OwnedFd::from_raw_fd(raw) };
    let mut how: libc::open_how = unsafe { std::mem::zeroed() };
    how.flags = (libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NONBLOCK) as u64;
    how.resolve = 0x08 | 0x04 | 0x02; // BENEATH | NO_SYMLINKS | NO_MAGICLINKS
    let raw = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            directory.as_raw_fd(),
            name.as_ptr(),
            &how,
            std::mem::size_of::<libc::open_how>(),
        )
    };
    let error = std::io::Error::last_os_error().raw_os_error();
    let source = if raw >= 0 {
        Some(unsafe { OwnedFd::from_raw_fd(raw as i32) })
    } else {
        None
    };
    if let Some(source) = source {
        // Keep this setup handle until memfd creation so its just-released
        // integer cannot become the reserved executable fd 3 prematurely.
        Ok((source, directory))
    } else {
        close_checked(directory)?;
        Err(
            if matches!(error, Some(libc::ENOSYS | libc::EINVAL | libc::E2BIG)) {
                FixtureImageFailure::Unavailable
            } else {
                FixtureImageFailure::Source
            },
        )
    }
}
fn positional_read(
    fd: BorrowedFd<'_>,
    bytes: &mut [u8],
    offset: usize,
    stop: BorrowedFd<'_>,
    deadline: Instant,
) -> Result<usize, FixtureImageFailure> {
    loop {
        checkpoint(stop, deadline)?;
        let n = unsafe {
            libc::pread(
                fd.as_raw_fd(),
                bytes.as_mut_ptr().cast(),
                bytes.len(),
                offset as libc::off_t,
            )
        };
        if n >= 0 {
            return Ok(n as usize);
        }
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return Err(FixtureImageFailure::Copy);
        }
    }
}
fn positional_write(
    fd: BorrowedFd<'_>,
    bytes: &[u8],
    offset: usize,
    stop: BorrowedFd<'_>,
    deadline: Instant,
) -> Result<(), FixtureImageFailure> {
    let mut written = 0;
    while written < bytes.len() {
        checkpoint(stop, deadline)?;
        let n = unsafe {
            libc::pwrite(
                fd.as_raw_fd(),
                bytes[written..].as_ptr().cast(),
                bytes.len() - written,
                (offset + written) as libc::off_t,
            )
        };
        if n > 0 {
            written += n as usize;
        } else if n == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return Err(FixtureImageFailure::Copy);
        }
    }
    Ok(())
}

pub(crate) fn prepare_fixture_image(
    source: &Path,
    invocation: [u8; 16],
    deadline: Instant,
    stop: BorrowedFd<'_>,
    fault: FixtureImageFault,
) -> Result<VerifiedFixtureImage, FixtureImageFailure> {
    prepare_fixture_image_observed(source, invocation, deadline, stop, fault, |_, _, _| Ok(()))
}
pub(crate) fn prepare_fixture_image_observed(
    source: &Path,
    invocation: [u8; 16],
    deadline: Instant,
    stop: BorrowedFd<'_>,
    fault: FixtureImageFault,
    mut observer: impl FnMut(
        FixtureImageStage,
        BorrowedFd<'_>,
        Instant,
    ) -> Result<(), FixtureImageFailure>,
) -> Result<VerifiedFixtureImage, FixtureImageFailure> {
    let deadline = deadline.min(Instant::now() + Duration::from_secs(2));
    checkpoint(stop, deadline)?;
    if !fixture_available() {
        return Err(FixtureImageFailure::Unavailable);
    }
    if fault == FixtureImageFault::Open {
        return Err(FixtureImageFailure::Source);
    }
    let (source, directory) = open_source(source)?;
    let initial = stat(source.as_fd())?;
    if !source_valid(&initial) {
        return Err(FixtureImageFailure::Source);
    }
    let mut mount = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatvfs(source.as_raw_fd(), &mut mount) } != 0 {
        return Err(FixtureImageFailure::Source);
    }
    if mount.f_flag & libc::ST_NOEXEC != 0 {
        return Err(FixtureImageFailure::NoExec);
    }
    checkpoint(stop, deadline)?;
    // Exactly one object. Unsupported executable-memfd policy never retries flags.
    let raw = unsafe {
        libc::memfd_create(
            c"probe-fixture-image".as_ptr(),
            libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING | libc::MFD_EXEC,
        )
    };
    if raw < 0 {
        return Err(FixtureImageFailure::Unavailable);
    }
    let image = unsafe { OwnedFd::from_raw_fd(raw) };
    close_checked(directory)?;
    if raw <= 3 {
        return Err(FixtureImageFailure::InvalidInput);
    }
    let length = initial.st_size as usize;
    let mut buffer = [0u8; CHUNK];
    let mut offset = 0;
    while offset < length {
        if fault == FixtureImageFault::Read {
            return Err(FixtureImageFailure::Copy);
        }
        let count = positional_read(
            source.as_fd(),
            &mut buffer[..CHUNK.min(length - offset)],
            offset,
            stop,
            deadline,
        )?;
        if count == 0 {
            return Err(FixtureImageFailure::Copy);
        }
        if fault == FixtureImageFault::Write {
            return Err(FixtureImageFailure::Copy);
        }
        positional_write(image.as_fd(), &buffer[..count], offset, stop, deadline)?;
        offset += count;
        observer(FixtureImageStage::CopyChunk, image.as_fd(), deadline)?;
        checkpoint(stop, deadline)?;
    }
    if positional_read(source.as_fd(), &mut buffer[..1], length, stop, deadline)? != 0
        || !unchanged(&initial, &stat(source.as_fd())?)
    {
        return Err(FixtureImageFailure::Source);
    }
    if fault == FixtureImageFault::Mode || unsafe { libc::fchmod(image.as_raw_fd(), 0o700) } != 0 {
        return Err(FixtureImageFailure::Mode);
    }
    let image_stat = stat(image.as_fd())?;
    if !image_valid(&image_stat) || image_stat.st_size != initial.st_size {
        return Err(FixtureImageFailure::Mode);
    }
    observer(FixtureImageStage::BeforeSeal, image.as_fd(), deadline)?;
    checkpoint(stop, deadline)?;
    // Mutations at the pre-seal stage must also pass source and snapshot checks.
    if !unchanged(&initial, &stat(source.as_fd())?) {
        return Err(FixtureImageFailure::Source);
    }
    if fault == FixtureImageFault::Seal
        || unsafe { libc::fcntl(image.as_raw_fd(), libc::F_ADD_SEALS, REQUIRED_SEALS) } != 0
    {
        return Err(FixtureImageFailure::Seal);
    }
    let seals = unsafe { libc::fcntl(image.as_raw_fd(), libc::F_GET_SEALS) };
    if seals < 0 || seals & REQUIRED_SEALS != REQUIRED_SEALS {
        return Err(FixtureImageFailure::Seal);
    }
    observer(FixtureImageStage::Sealed, image.as_fd(), deadline)?;
    checkpoint(stop, deadline)?;
    let sealed_stat = stat(image.as_fd())?;
    if !image_valid(&sealed_stat) || sealed_stat.st_size != length as i64 {
        return Err(FixtureImageFailure::Mode);
    }
    if fault == FixtureImageFault::Readback {
        return Err(FixtureImageFailure::Readback);
    }
    let mut bytes = vec![0u8; length];
    let mut offset = 0;
    while offset < length {
        let end = length.min(offset + CHUNK);
        let count = positional_read(
            image.as_fd(),
            &mut bytes[offset..end],
            offset,
            stop,
            deadline,
        )
        .map_err(|e| {
            if e == FixtureImageFailure::Copy {
                FixtureImageFailure::Readback
            } else {
                e
            }
        })?;
        if count == 0 {
            return Err(FixtureImageFailure::Readback);
        }
        offset += count;
    }
    if positional_read(image.as_fd(), &mut buffer[..1], length, stop, deadline)? != 0 {
        return Err(FixtureImageFailure::Readback);
    }
    validate_elf(&bytes)?;
    if fault == FixtureImageFault::Compare || bytes != EMBEDDED_A {
        return Err(FixtureImageFailure::Compare);
    }
    observer(FixtureImageStage::Compared, image.as_fd(), deadline)?;
    close_checked(source)?;
    if fault == FixtureImageFault::Close {
        return Err(FixtureImageFailure::Close);
    }
    checkpoint(stop, deadline)?;
    Ok(VerifiedFixtureImage {
        fd: image,
        invocation,
        preparation_deadline: deadline,
    })
}

// This is intentionally narrower than the passive installer inspector. Every
// successful parser result must still pass complete equality with embedded A.
fn validate_elf(bytes: &[u8]) -> Result<(), FixtureImageFailure> {
    let invalid = FixtureImageFailure::Elf;
    if !(64..=MAX_IMAGE).contains(&bytes.len()) || &bytes[..7] != b"\x7fELF\x02\x01\x01" {
        return Err(invalid);
    }
    let u16_at = |offset| u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap());
    let u32_at = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    let u64_at = |offset| u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
    if u16_at(16) != 2
        || u16_at(18) != 62
        || u32_at(20) != 1
        || u16_at(52) != 64
        || u16_at(54) != 56
    {
        return Err(invalid);
    }
    let count = u16_at(56) as usize;
    let table = usize::try_from(u64_at(32)).map_err(|_| invalid)?;
    let end = table
        .checked_add(count.checked_mul(56).ok_or(invalid)?)
        .ok_or(invalid)?;
    if count == 0 || count > 256 || table < 64 || end > bytes.len() {
        return Err(invalid);
    }
    let entry = u64_at(24);
    let mut backed_entry = false;
    for i in 0..count {
        let p = table + i * 56;
        let kind = u32_at(p);
        if kind == 2 || kind == 3 {
            return Err(invalid);
        }
        let offset = u64_at(p + 8);
        let virtual_address = u64_at(p + 16);
        let file_size = u64_at(p + 32);
        let memory_size = u64_at(p + 40);
        let alignment = u64_at(p + 48);
        if offset
            .checked_add(file_size)
            .is_none_or(|end| end > bytes.len() as u64)
        {
            return Err(invalid);
        }
        if kind == 1 {
            let memory_end = virtual_address.checked_add(memory_size).ok_or(invalid)?;
            let file_end = virtual_address.checked_add(file_size).ok_or(invalid)?;
            if file_size > memory_size
                || memory_end > 0x0000_8000_0000_0000
                || offset % 4096 != virtual_address % 4096
                || (alignment > 1
                    && (!alignment.is_power_of_two()
                        || offset % alignment != virtual_address % alignment))
            {
                return Err(invalid);
            }
            backed_entry |= entry != 0
                && u32_at(p + 4) & 1 != 0
                && entry >= virtual_address
                && entry < file_end;
        }
    }
    if !backed_entry {
        return Err(invalid);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn elf() -> Vec<u8> {
        let mut bytes = vec![0; 256];
        bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        bytes[16..18].copy_from_slice(&2u16.to_le_bytes());
        bytes[18..20].copy_from_slice(&62u16.to_le_bytes());
        bytes[20..24].copy_from_slice(&1u32.to_le_bytes());
        bytes[24..32].copy_from_slice(&0x400080u64.to_le_bytes());
        bytes[32..40].copy_from_slice(&64u64.to_le_bytes());
        bytes[52..54].copy_from_slice(&64u16.to_le_bytes());
        bytes[54..56].copy_from_slice(&56u16.to_le_bytes());
        bytes[56..58].copy_from_slice(&1u16.to_le_bytes());
        bytes[64..68].copy_from_slice(&1u32.to_le_bytes());
        bytes[68..72].copy_from_slice(&5u32.to_le_bytes());
        bytes[80..88].copy_from_slice(&0x400000u64.to_le_bytes());
        bytes[96..104].copy_from_slice(&256u64.to_le_bytes());
        bytes[104..112].copy_from_slice(&256u64.to_le_bytes());
        bytes[112..120].copy_from_slice(&4096u64.to_le_bytes());
        bytes
    }
    #[test]
    fn narrow_parser_rejects_invalid_layouts() {
        assert_eq!(validate_elf(&elf()), Ok(()));
        for prefix in 0..120 {
            assert_eq!(
                validate_elf(&elf()[..prefix]),
                Err(FixtureImageFailure::Elf)
            );
        }
        for (offset, bytes) in [
            (0, b"#!xx".to_vec()),
            (4, vec![1]),
            (5, vec![2]),
            (6, vec![0]),
            (16, 3u16.to_le_bytes().to_vec()),
            (18, 183u16.to_le_bytes().to_vec()),
            (20, 0u32.to_le_bytes().to_vec()),
            (52, 63u16.to_le_bytes().to_vec()),
            (54, 55u16.to_le_bytes().to_vec()),
            (56, 0u16.to_le_bytes().to_vec()),
            (56, 257u16.to_le_bytes().to_vec()),
            (56, 0xffffu16.to_le_bytes().to_vec()),
            (32, u64::MAX.to_le_bytes().to_vec()),
            (32, 240u64.to_le_bytes().to_vec()),
            (24, 0u64.to_le_bytes().to_vec()),
            (24, 0x400100u64.to_le_bytes().to_vec()),
            (64, 2u32.to_le_bytes().to_vec()),
            (64, 3u32.to_le_bytes().to_vec()),
            (68, 4u32.to_le_bytes().to_vec()),
            (72, u64::MAX.to_le_bytes().to_vec()),
            (72, 1u64.to_le_bytes().to_vec()),
            (80, u64::MAX.to_le_bytes().to_vec()),
            (96, 257u64.to_le_bytes().to_vec()),
            (104, 255u64.to_le_bytes().to_vec()),
            (104, u64::MAX.to_le_bytes().to_vec()),
            (112, 3u64.to_le_bytes().to_vec()),
        ] {
            let mut candidate = elf();
            candidate[offset..offset + bytes.len()].copy_from_slice(&bytes);
            assert_eq!(
                validate_elf(&candidate),
                Err(FixtureImageFailure::Elf),
                "field {offset}"
            );
        }
        assert_eq!(
            validate_elf(&vec![0; MAX_IMAGE + 1]),
            Err(FixtureImageFailure::Elf)
        );
    }
    #[test]
    fn stop_and_deadline_close_admission() {
        assert_eq!(
            open_source(Path::new(&"x".repeat(3073))).unwrap_err(),
            FixtureImageFailure::InvalidInput
        );
        let (read, mut write) = UnixStream::pair().unwrap();
        assert_eq!(
            checkpoint(read.as_fd(), Instant::now()),
            Err(FixtureImageFailure::Deadline)
        );
        assert_eq!(
            checkpoint(read.as_fd(), Instant::now() + Duration::from_secs(1)),
            Ok(())
        );
        std::io::Write::write_all(&mut write, b"stop").unwrap();
        assert_eq!(
            checkpoint(read.as_fd(), Instant::now() + Duration::from_secs(1)),
            Err(FixtureImageFailure::Stopped)
        );
        let (read, write) = UnixStream::pair().unwrap();
        drop(write);
        assert_eq!(
            checkpoint(read.as_fd(), Instant::now() + Duration::from_secs(1)),
            Err(FixtureImageFailure::Stopped)
        );
    }
    // Preparation requires fd 3 to remain the stop endpoint until target setup.
    // A lock within this module cannot prevent other parallel unit tests from
    // releasing a low descriptor. Run each real preparer in its own test process.
    fn isolated_preparer(test: &str) -> bool {
        let test = format!("probe_artifact::tests::{test}");
        if std::env::var_os("GS_ARTIFACT_PREPARER_CHILD").as_deref()
            == Some(std::ffi::OsStr::new(&test))
        {
            return true;
        }
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &test, "--nocapture", "--test-threads=1"])
            .env("GS_ARTIFACT_PREPARER_CHILD", &test)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    assert!(status.success(), "isolated preparer {test}: {status}");
                    return false;
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                result => {
                    // No namespace or target is created by these preparer tests.
                    // A filesystem syscall may resist SIGKILL; never wait forever
                    // for the exact child after the watchdog. Retain its files.
                    let pid = child.id();
                    let _ = child.kill();
                    let reap_deadline = Instant::now() + Duration::from_secs(1);
                    let mut reaped = false;
                    while Instant::now() < reap_deadline {
                        match child.try_wait() {
                            Ok(Some(_)) => {
                                reaped = true;
                                break;
                            }
                            Err(_) => break,
                            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
                        }
                    }
                    panic!(
                        "isolated preparer {test} watchdog/wait failure: {result:?}; child {pid} reaped={reaped}; fixture files retained"
                    );
                }
            }
        }
    }
    struct Fixture {
        dir: PathBuf,
        source: PathBuf,
        stop: UnixStream,
        _peer: UnixStream,
    }
    impl Fixture {
        fn under(base: &Path) -> Self {
            static SERIAL: AtomicUsize = AtomicUsize::new(0);
            let mut random = [0u8; 8];
            assert_eq!(
                unsafe { libc::getrandom(random.as_mut_ptr().cast(), random.len(), 0) },
                8
            );
            let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
            let dir = base.join(format!(
                "gs-image-{}-{serial}-{:016x}",
                std::process::id(),
                u64::from_ne_bytes(random)
            ));
            fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
            let source = dir.join("image");
            fs::write(&source, EMBEDDED_A).unwrap();
            fs::set_permissions(&source, fs::Permissions::from_mode(0o700)).unwrap();
            let (stop, peer) = UnixStream::pair().unwrap();
            // Match the bound driver's occupied low control/proof slots. No
            // other test in this process may recycle either during preparation.
            assert_eq!(stop.as_raw_fd(), 3);
            assert_eq!(peer.as_raw_fd(), 4);
            Self {
                dir,
                source,
                stop,
                _peer: peer,
            }
        }
        fn new() -> Option<Self> {
            if !fixture_available() {
                eprintln!("UNAVAILABLE: native static A/B fixture images");
                return None;
            }
            Some(Self::under(&std::env::temp_dir()))
        }
        fn prepare(
            &self,
            fault: FixtureImageFault,
        ) -> Result<VerifiedFixtureImage, FixtureImageFailure> {
            prepare_fixture_image(
                &self.source,
                [1; 16],
                Instant::now() + Duration::from_secs(2),
                self.stop.as_fd(),
                fault,
            )
        }
        fn observed(
            &self,
            observer: impl FnMut(
                FixtureImageStage,
                BorrowedFd<'_>,
                Instant,
            ) -> Result<(), FixtureImageFailure>,
        ) -> Result<VerifiedFixtureImage, FixtureImageFailure> {
            prepare_fixture_image_observed(
                &self.source,
                [1; 16],
                Instant::now() + Duration::from_secs(2),
                self.stop.as_fd(),
                FixtureImageFault::None,
                observer,
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            eprintln!(
                "RETAINED zero-execution image unit fixture: {}",
                self.dir.display()
            );
        }
    }
    fn available(
        result: Result<VerifiedFixtureImage, FixtureImageFailure>,
    ) -> Option<VerifiedFixtureImage> {
        match result {
            Ok(image) => Some(image),
            Err(FixtureImageFailure::Unavailable) => {
                eprintln!("UNAVAILABLE: executable memfd/openat2 kernel policy");
                None
            }
            Err(error) => panic!("unexpected image admission: {error:?}"),
        }
    }
    #[test]
    fn real_full_seals_identity_and_alias_enforcement() {
        if !isolated_preparer("real_full_seals_identity_and_alias_enforcement") {
            return;
        }
        let Some(fixture) = Fixture::new() else {
            return;
        };
        let deadline = Instant::now() + Duration::from_millis(1500);
        let Some(image) = available(prepare_fixture_image(
            &fixture.source,
            [1; 16],
            deadline,
            fixture.stop.as_fd(),
            FixtureImageFault::None,
        )) else {
            return;
        };
        assert_eq!(image.preparation_deadline(), deadline);
        assert!(image.matches_invocation([1; 16]));
        assert!(!image.matches_invocation([2; 16]));
        assert!(image.as_raw_fd() > 3);
        let fd = image.as_raw_fd();
        assert_ne!(
            unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_GET_SEALS) } & REQUIRED_SEALS,
            REQUIRED_SEALS
        );
        let alias = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 5) };
        assert!(alias >= 5);
        let alias = unsafe { OwnedFd::from_raw_fd(alias) };
        let fd = alias.as_raw_fd();
        assert_eq!(unsafe { libc::pwrite(fd, c"x".as_ptr().cast(), 1, 0) }, -1);
        assert_eq!(unsafe { libc::ftruncate(fd, 0) }, -1);
        assert_eq!(
            unsafe { libc::ftruncate(fd, EMBEDDED_A.len() as i64 + 1) },
            -1
        );
        assert_eq!(
            unsafe {
                libc::fallocate(
                    fd,
                    libc::FALLOC_FL_PUNCH_HOLE | libc::FALLOC_FL_KEEP_SIZE,
                    0,
                    4096,
                )
            },
            -1
        );
        assert_eq!(
            unsafe {
                libc::mmap(
                    std::ptr::null_mut(),
                    4096,
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_SHARED,
                    fd,
                    0,
                )
            },
            libc::MAP_FAILED
        );
        assert_eq!(unsafe { libc::fchmod(fd, 0o600) }, -1);
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_ADD_SEALS, libc::F_SEAL_FUTURE_WRITE) },
            -1
        );
        close_checked(alias).unwrap();
    }
    #[test]
    fn failure_hooks_never_admit() {
        if !isolated_preparer("failure_hooks_never_admit") {
            return;
        }
        let Some(fixture) = Fixture::new() else {
            return;
        };
        let Some(image) = available(fixture.prepare(FixtureImageFault::None)) else {
            return;
        };
        drop(image);
        for fault in [
            FixtureImageFault::Open,
            FixtureImageFault::Read,
            FixtureImageFault::Write,
            FixtureImageFault::Mode,
            FixtureImageFault::Seal,
            FixtureImageFault::Readback,
            FixtureImageFault::Compare,
            FixtureImageFault::Close,
        ] {
            assert!(
                fixture.prepare(fault).is_err(),
                "fault {fault:?} admitted an image"
            );
        }
        assert_eq!(
            prepare_fixture_image(
                &fixture.source,
                [1; 16],
                Instant::now(),
                fixture.stop.as_fd(),
                FixtureImageFault::None
            )
            .unwrap_err(),
            FixtureImageFailure::Deadline
        );
    }
    #[test]
    fn unsafe_sources_and_b_refuse() {
        if !isolated_preparer("unsafe_sources_and_b_refuse") {
            return;
        }
        let Some(fixture) = Fixture::new() else {
            return;
        };
        let Some(image) = available(fixture.prepare(FixtureImageFault::None)) else {
            return;
        };
        drop(image);
        fs::write(&fixture.source, EMBEDDED_B).unwrap();
        assert_eq!(
            fixture.prepare(FixtureImageFault::None).unwrap_err(),
            FixtureImageFailure::Compare
        );
        fs::write(&fixture.source, EMBEDDED_A).unwrap();
        fs::set_permissions(&fixture.source, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            fixture.prepare(FixtureImageFault::None).unwrap_err(),
            FixtureImageFailure::Source
        );
        fs::set_permissions(&fixture.source, fs::Permissions::from_mode(0o700)).unwrap();
        fs::hard_link(&fixture.source, fixture.dir.join("link")).unwrap();
        assert_eq!(
            fixture.prepare(FixtureImageFault::None).unwrap_err(),
            FixtureImageFailure::Source
        );
        // Remove only this exact unit-owned link, after verified zero-target refusal.
        fs::remove_file(fixture.dir.join("link")).unwrap();
        std::os::unix::fs::symlink(&fixture.source, fixture.dir.join("symlink")).unwrap();
        assert_eq!(
            prepare_fixture_image(
                &fixture.dir.join("symlink"),
                [1; 16],
                Instant::now() + Duration::from_secs(2),
                fixture.stop.as_fd(),
                FixtureImageFault::None
            )
            .unwrap_err(),
            FixtureImageFailure::Source
        );
        for size in [63, MAX_IMAGE + 1] {
            fs::File::options()
                .write(true)
                .open(&fixture.source)
                .unwrap()
                .set_len(size as u64)
                .unwrap();
            assert_eq!(
                fixture.prepare(FixtureImageFault::None).unwrap_err(),
                FixtureImageFailure::Source
            );
        }
        fs::write(&fixture.source, elf()).unwrap();
        assert_eq!(
            fixture.prepare(FixtureImageFault::None).unwrap_err(),
            FixtureImageFailure::Compare
        );
        fs::write(&fixture.source, vec![0u8; 64]).unwrap();
        assert_eq!(
            fixture.prepare(FixtureImageFault::None).unwrap_err(),
            FixtureImageFailure::Elf
        );
    }
    #[test]
    fn copying_and_preseal_mutations_refuse() {
        if !isolated_preparer("copying_and_preseal_mutations_refuse") {
            return;
        }
        let Some(fixture) = Fixture::new() else {
            return;
        };
        let Some(image) = available(fixture.prepare(FixtureImageFault::None)) else {
            return;
        };
        drop(image);
        for size in [32, EMBEDDED_A.len() + 1] {
            fs::write(&fixture.source, EMBEDDED_A).unwrap();
            let mut done = false;
            assert!(
                fixture
                    .observed(|stage, _, _| {
                        if stage == FixtureImageStage::CopyChunk && !done {
                            done = true;
                            fs::File::options()
                                .write(true)
                                .open(&fixture.source)
                                .unwrap()
                                .set_len(size as u64)
                                .unwrap();
                        }
                        Ok(())
                    })
                    .is_err()
            );
            assert!(done);
        }
        fs::write(&fixture.source, EMBEDDED_A).unwrap();
        assert_eq!(
            fixture
                .observed(|stage, fd, _| {
                    if stage == FixtureImageStage::BeforeSeal {
                        assert_eq!(
                            unsafe { libc::pwrite(fd.as_raw_fd(), c"x".as_ptr().cast(), 1, 0) },
                            1
                        );
                    }
                    Ok(())
                })
                .unwrap_err(),
            FixtureImageFailure::Elf
        );
        fs::write(&fixture.source, EMBEDDED_A).unwrap();
        assert_eq!(
            fixture
                .observed(|stage, _, _| {
                    if stage == FixtureImageStage::BeforeSeal {
                        fs::set_permissions(&fixture.source, fs::Permissions::from_mode(0o600))
                            .unwrap();
                    }
                    Ok(())
                })
                .unwrap_err(),
            FixtureImageFailure::Source
        );
    }
    #[test]
    fn outstanding_shared_writable_mapping_prevents_seal() {
        if !isolated_preparer("outstanding_shared_writable_mapping_prevents_seal") {
            return;
        }
        let Some(fixture) = Fixture::new() else {
            return;
        };
        let Some(image) = available(fixture.prepare(FixtureImageFault::None)) else {
            return;
        };
        drop(image);
        let mut mapping = libc::MAP_FAILED;
        let result = fixture.observed(|stage, fd, _| {
            if stage == FixtureImageStage::BeforeSeal {
                mapping = unsafe {
                    libc::mmap(
                        std::ptr::null_mut(),
                        4096,
                        libc::PROT_READ | libc::PROT_WRITE,
                        libc::MAP_SHARED,
                        fd.as_raw_fd(),
                        0,
                    )
                };
                assert_ne!(mapping, libc::MAP_FAILED);
            }
            Ok(())
        });
        if mapping != libc::MAP_FAILED {
            assert_eq!(unsafe { libc::munmap(mapping, 4096) }, 0);
        }
        assert_eq!(result.unwrap_err(), FixtureImageFailure::Seal);
    }
    #[test]
    fn postcompare_source_changes_leave_sealed_a_unchanged() {
        if !isolated_preparer("postcompare_source_changes_leave_sealed_a_unchanged") {
            return;
        }
        let Some(fixture) = Fixture::new() else {
            return;
        };
        let Some(image) = available(fixture.prepare(FixtureImageFault::None)) else {
            return;
        };
        drop(image);
        for replace in [false, true] {
            fs::write(&fixture.source, EMBEDDED_A).unwrap();
            let image = fixture
                .observed(|stage, _, _| {
                    if stage == FixtureImageStage::Compared {
                        if replace {
                            fs::write(fixture.dir.join("replacement"), EMBEDDED_B).unwrap();
                            fs::set_permissions(
                                fixture.dir.join("replacement"),
                                fs::Permissions::from_mode(0o700),
                            )
                            .unwrap();
                            fs::rename(fixture.dir.join("replacement"), &fixture.source).unwrap();
                        } else {
                            fs::write(&fixture.source, EMBEDDED_B).unwrap();
                        }
                    }
                    Ok(())
                })
                .unwrap();
            let mut bytes = vec![0u8; EMBEDDED_A.len()];
            let mut offset = 0;
            while offset < bytes.len() {
                let n = positional_read(
                    image.as_fd(),
                    &mut bytes[offset..],
                    offset,
                    fixture.stop.as_fd(),
                    Instant::now() + Duration::from_secs(2),
                )
                .unwrap();
                assert!(n > 0);
                offset += n;
            }
            assert_eq!(bytes, EMBEDDED_A);
            assert_eq!(fs::read(&fixture.source).unwrap(), EMBEDDED_B);
        }
    }
    #[test]
    fn noexec_source_is_not_promoted() {
        if !isolated_preparer("noexec_source_is_not_promoted") {
            return;
        }
        if !fixture_available() {
            eprintln!("UNAVAILABLE: native static A/B fixture images");
            return;
        }
        let directory = c"/dev/shm";
        let raw = unsafe {
            libc::open(
                directory.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if raw < 0 {
            eprintln!("UNAVAILABLE: fixed noexec unit source location");
            return;
        }
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        let mut flags = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatvfs(fd.as_raw_fd(), &mut flags) } != 0
            || flags.f_flag & libc::ST_NOEXEC == 0
        {
            eprintln!("UNAVAILABLE: fixed source is not noexec");
            return;
        }
        close_checked(fd).unwrap();
        let fixture = Fixture::under(Path::new("/dev/shm"));
        assert_eq!(
            fixture.prepare(FixtureImageFault::None).unwrap_err(),
            FixtureImageFailure::NoExec
        );
    }
}
