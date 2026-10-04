//! Fixture-only owned PID-namespace lifetime. Not compiled into production dispatch.
//! A token is constructed solely after reaping this invocation's atomically obtained
//! init pidfd. It authorizes no context deletion and has no serialization contract.
//! Linux PID namespace teardown runs before init can be reaped (see
//! kernel/pid_namespace.c: zap_pid_ns_processes). Signals and pipe EOF are not proof.

use std::ffi::CString;
use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};
use std::time::{Duration, Instant};

use crate::probe_artifact::VerifiedFixtureImage;
use crate::probe_context::{
    CapturedContext, ContextFailure, ContextFault, ContextStage, FixtureContextPlan,
};

#[derive(Debug)]
pub struct NamespaceTermination {
    _private: (),
}
#[derive(Debug)]
pub struct ProbeCompletion {
    pub outcome: Outcome,
    pub termination: NamespaceTermination,
}
// Only run_bound can associate an image with actual owned-init reaping. In
// particular, a pathname completion has no conversion into this private owner.
#[derive(Debug)]
pub(crate) struct BoundProbeCompletion {
    completion: ProbeCompletion,
    image: VerifiedFixtureImage,
    invocation: [u8; 16],
}
impl BoundProbeCompletion {
    pub(crate) fn into_completion(self, invocation: [u8; 16]) -> Result<ProbeCompletion, Failure> {
        if self.invocation != invocation || !self.image.matches_invocation(invocation) {
            return Err(Failure::InvalidInput);
        }
        Ok(self.completion)
    }
}
// Constructed only by the fixed contextual run, retaining that run's actual
// capture, selected plan, sealed image and invocation. Teardown is not execution.
#[derive(Debug)]
pub(crate) struct ContextFixtureCompletion {
    completion: ProbeCompletion,
    image: VerifiedFixtureImage,
    context: CapturedContext,
    invocation: [u8; 16],
}
impl ContextFixtureCompletion {
    pub(crate) fn into_completion(self, invocation: [u8; 16]) -> Result<ProbeCompletion, Failure> {
        if self.invocation != invocation
            || !self.image.matches_invocation(invocation)
            || !self.context.matches_invocation(invocation)
        {
            return Err(Failure::InvalidInput);
        }
        Ok(self.completion)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ContextExecutionFault {
    None,
    InitialAlias,
    FinalAlias,
    ScannerClose,
}
// Bound-only fail-closed seams: none can supply an image or a successful wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BoundExecutionFault {
    None,
    Dup,
    CloseRange,
    Exec,
    Inventory,
    EntryDeadline,
    PreCloneDeadline,
    GateDeadline,
    ReleaseDeadline,
    ExecDeadline,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Exited(i32),
    Signalled(i32),
    Stopped,
    SetupFailed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    InvalidInput,
    Unsupported(i32),
    Admission,
    TerminationUnproven,
}
// Trusted, bounded fixture seams only. None can supply a successful wait result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    None,
    Clone,
    CreatorPidfd,
    Mapping,
    Wait,
    WithholdWait,
    BeforePdeath,
    ControlError,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Registered,
    BeforeRegistration,
    Mapping,
    Gate,
    Admitted,
}

pub struct Options<'a> {
    pub argv: &'a [String],
    pub stop: BorrowedFd<'a>,
    pub stdio: [BorrowedFd<'a>; 3],
    pub wall: Duration,
    pub observation: Duration,
    pub fault: Fault,
    /// Trusted pre-restriction nested namespace fixture, never target acceptance.
    pub nested_fixture: bool,
    /// Fixture guard/protocol handles closed immediately in init, before target fork.
    pub close_in_init: &'a [RawFd],
}

#[cfg(not(probe_clone_unavailable))]
unsafe extern "C" {
    fn gs_probe_clone(
        pidfd: *mut i32,
        child: extern "C" fn(*mut libc::c_void),
        context: *mut libc::c_void,
    ) -> libc::c_long;
}
#[cfg(probe_clone_unavailable)]
unsafe fn gs_probe_clone(
    _pidfd: *mut i32,
    _child: extern "C" fn(*mut libc::c_void),
    _context: *mut libc::c_void,
) -> libc::c_long {
    unsafe { *libc::__errno_location() = libc::ENOSYS };
    -1
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct CapHeader {
    version: u32,
    pid: i32,
}
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct CapData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}
fn caps() -> Result<[CapData; 2], Failure> {
    let mut header = CapHeader {
        version: 0x20080522,
        pid: 0,
    };
    let mut data = [CapData::default(); 2];
    if unsafe { libc::syscall(libc::SYS_capget, &mut header, data.as_mut_ptr()) } != 0 {
        return Err(Failure::Admission);
    }
    Ok(data)
}
fn zero_caps() -> bool {
    caps().is_ok_and(|v| {
        v.iter()
            .all(|c| c.effective == 0 && c.permitted == 0 && c.inheritable == 0)
    })
}
fn errno() -> i32 {
    std::io::Error::last_os_error()
        .raw_os_error()
        .unwrap_or(libc::EIO)
}
fn owned(fd: i32) -> Result<OwnedFd, Failure> {
    if fd < 0 {
        Err(Failure::Unsupported(errno()))
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}
fn socketpair() -> Result<[OwnedFd; 2], Failure> {
    let mut fds = [-1; 2];
    if unsafe {
        libc::socketpair(
            libc::AF_UNIX,
            libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC,
            0,
            fds.as_mut_ptr(),
        )
    } != 0
    {
        return Err(Failure::Unsupported(errno()));
    }
    Ok([owned(fds[0])?, owned(fds[1])?])
}
fn close_checked(fd: RawFd) -> bool {
    unsafe {
        libc::close(fd);
    }
    unsafe { libc::fcntl(fd, libc::F_GETFD) == -1 && errno() == libc::EBADF }
}
fn ready(fd: RawFd) -> Result<bool, Failure> {
    let mut p = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    let r = unsafe { libc::poll(&mut p, 1, 0) };
    if r < 0 {
        return Err(Failure::Admission);
    }
    Ok(r != 0) // Data, EOF, HUP and invalid descriptors all stop admission.
}
fn send(fd: RawFd, byte: u8) -> bool {
    unsafe {
        libc::send(
            fd,
            (&byte as *const u8).cast(),
            1,
            libc::MSG_NOSIGNAL | libc::MSG_DONTWAIT,
        ) == 1
    }
}
fn receive(fd: RawFd, expected: u8, deadline: Instant) -> bool {
    while Instant::now() < deadline {
        if ready(fd) != Ok(false) {
            let mut bytes = [0u8; 2];
            return unsafe { libc::recv(fd, bytes.as_mut_ptr().cast(), 2, libc::MSG_DONTWAIT) }
                == 1
                && bytes[0] == expected;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    false
}
pub fn signal_init(fd: BorrowedFd<'_>) -> bool {
    unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            fd.as_raw_fd(),
            libc::SIGKILL,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        ) == 0
    }
}
// Used independently by the native fixture guard only after adoption. It cannot
// construct NamespaceTermination; only run's private OwnedInit has that authority.
pub fn exact_reap(fd: BorrowedFd<'_>) -> Result<Option<(i32, i32)>, Failure> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let rc = unsafe {
        libc::waitid(
            libc::P_PIDFD,
            fd.as_raw_fd() as u32,
            &mut info,
            libc::WEXITED | libc::WNOHANG,
        )
    };
    if rc != 0 {
        if errno() == libc::EINTR {
            return Ok(None);
        }
        return Err(Failure::TerminationUnproven);
    }
    if unsafe { info.si_pid() } == 0 {
        return Ok(None);
    }
    if ![libc::CLD_EXITED, libc::CLD_KILLED, libc::CLD_DUMPED].contains(&info.si_code) {
        return Err(Failure::TerminationUnproven);
    }
    Ok(Some((info.si_code, unsafe { info.si_status() })))
}
struct OwnedInit {
    fd: OwnedFd,
}
impl Drop for OwnedInit {
    fn drop(&mut self) {
        use std::os::fd::AsFd;
        signal_init(self.fd.as_fd()); // Never an unbounded destructor wait or PID fallback.
    }
}
fn validate(options: &Options<'_>) -> Result<Vec<CString>, Failure> {
    if options.argv.is_empty()
        || options.argv.len() > 32
        || !options.argv[0].starts_with('/')
        || options.argv.iter().map(String::len).sum::<usize>() > 16384
        || options.wall < Duration::from_millis(10)
        || options.wall > Duration::from_secs(10)
        || options.observation < Duration::from_millis(10)
        || options.observation > Duration::from_secs(3)
        || options.stdio.iter().any(|fd| fd.as_raw_fd() < 3)
        || options.stop.as_raw_fd() < 3
        || options
            .stdio
            .iter()
            .any(|fd| fd.as_raw_fd() == options.stop.as_raw_fd())
        || options.close_in_init.len() > 16
        || options.close_in_init.iter().any(|fd| {
            *fd < 3
                || *fd == options.stop.as_raw_fd()
                || options.stdio.iter().any(|stdio| *fd == stdio.as_raw_fd())
        })
    {
        return Err(Failure::InvalidInput);
    }
    options
        .argv
        .iter()
        .map(|v| CString::new(v.as_bytes()).map_err(|_| Failure::InvalidInput))
        .collect()
}
fn identity() -> Result<(u32, u32), Failure> {
    let (mut r, mut e, mut s) = (0, 0, 0);
    let (mut gr, mut ge, mut gs) = (0, 0, 0);
    if unsafe { libc::getresuid(&mut r, &mut e, &mut s) } != 0
        || unsafe { libc::getresgid(&mut gr, &mut ge, &mut gs) } != 0
        || r == 0
        || gr == 0
        || r != e
        || r != s
        || gr != ge
        || gr != gs
        || unsafe { libc::setfsuid(u32::MAX) } as u32 != e
        || unsafe { libc::setfsgid(u32::MAX) } as u32 != ge
        || !zero_caps()
    {
        return Err(Failure::Admission);
    }
    let count = std::fs::read_dir("/proc/self/task")
        .map_err(|_| Failure::Admission)?
        .count();
    if count != 1 {
        return Err(Failure::Admission);
    }
    Ok((r, gr))
}
fn mappings(pid: i32, uid: u32, gid: u32) -> Result<(), Failure> {
    // This PID is returned by clone3 and remains our unreaped child; never supplied
    // by a caller. /proc is used only outside the namespace for exact map files.
    let base = format!("/proc/{pid}");
    for (name, value) in [
        ("setgroups", "deny\n".to_owned()),
        ("uid_map", format!("{uid} {uid} 1\n")),
        ("gid_map", format!("{gid} {gid} 1\n")),
    ] {
        std::fs::write(format!("{base}/{name}"), &value).map_err(|_| Failure::Admission)?;
        let read =
            std::fs::read_to_string(format!("{base}/{name}")).map_err(|_| Failure::Admission)?;
        if read.split_whitespace().collect::<Vec<_>>()
            != value.split_whitespace().collect::<Vec<_>>()
        {
            return Err(Failure::Admission);
        }
    }
    Ok(())
}
fn supplementary_groups() -> Result<Vec<u32>, Failure> {
    let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
    if !(0..=64).contains(&count) {
        return Err(Failure::Admission);
    }
    let mut groups = vec![0; count as usize];
    if unsafe { libc::getgroups(count, groups.as_mut_ptr()) } != count {
        return Err(Failure::Admission);
    }
    Ok(groups)
}
fn drop_credentials(uid: u32, gid: u32, expected_groups: &[u32]) -> bool {
    unsafe {
        // Lock NOROOT, NO_SETUID_FIXUP, disabled KEEP_CAPS, and no ambient raises.
        const SECURE: libc::c_ulong = 0xef;
        if supplementary_groups().as_deref() != Ok(expected_groups)
            || libc::setresgid(gid, gid, gid) != 0
            || libc::setresuid(uid, uid, uid) != 0
            || libc::prctl(libc::PR_SET_SECUREBITS, SECURE, 0, 0, 0) != 0
            || libc::prctl(libc::PR_GET_SECUREBITS, 0, 0, 0, 0) != SECURE as i32
            || libc::prctl(
                libc::PR_CAP_AMBIENT,
                libc::PR_CAP_AMBIENT_CLEAR_ALL,
                0,
                0,
                0,
            ) != 0
        {
            return false;
        }
        // Discover the kernel's actual capability range; unknown future ranges refuse.
        let mut ended = false;
        for cap in 0..64 {
            let value = libc::prctl(libc::PR_CAPBSET_READ, cap, 0, 0, 0);
            if value < 0 {
                if errno() == libc::EINVAL && cap > 0 {
                    ended = true;
                    break;
                }
                return false;
            }
            if libc::prctl(libc::PR_CAPBSET_DROP, cap, 0, 0, 0) != 0
                || libc::prctl(libc::PR_CAPBSET_READ, cap, 0, 0, 0) != 0
                || libc::prctl(libc::PR_CAP_AMBIENT, libc::PR_CAP_AMBIENT_IS_SET, cap, 0, 0) != 0
            {
                return false;
            }
        }
        if !ended {
            return false;
        }
        let mut header = CapHeader {
            version: 0x20080522,
            pid: 0,
        };
        let data = [CapData::default(); 2];
        if libc::syscall(libc::SYS_capset, &mut header, data.as_ptr()) != 0
            || !zero_caps()
            || libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
            || libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1
            || libc::getuid() != uid
            || libc::geteuid() != uid
            || libc::getgid() != gid
            || libc::getegid() != gid
        {
            return false;
        }
    }
    true
}
fn pdeath(creator: RawFd) -> bool {
    let mut signal: i32 = 0;
    unsafe {
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) == 0
            && libc::prctl(libc::PR_GET_PDEATHSIG, &mut signal, 0, 0, 0) == 0
            && signal == libc::SIGKILL
            && ready(creator) == Ok(false)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DescriptorIdentity {
    device: libc::dev_t,
    inode: libc::ino_t,
    mode: libc::mode_t,
    special_device: libc::dev_t,
}
fn descriptor_stat(fd: RawFd) -> Option<libc::stat> {
    let mut stat = unsafe { std::mem::zeroed() };
    (unsafe { libc::fstat(fd, &mut stat) } == 0).then_some(stat)
}
fn descriptor_identity(stat: &libc::stat) -> DescriptorIdentity {
    DescriptorIdentity {
        device: stat.st_dev,
        inode: stat.st_ino,
        mode: stat.st_mode,
        special_device: stat.st_rdev,
    }
}
const IMAGE_SEALS: i32 =
    libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL | 0x20; // F_SEAL_EXEC
#[derive(Clone, Copy)]
struct BoundTarget {
    source: RawFd,
    identity: DescriptorIdentity,
    size: libc::off_t,
    seals: i32,
    stdio: [DescriptorIdentity; 3],
    fault: BoundExecutionFault,
    preparation_deadline: Instant,
    contextual: Option<ContextExecStorage>,
}
#[derive(Clone, Copy)]
struct ContextExecStorage {
    argv: *const *const libc::c_char,
    envp: *const *const libc::c_char,
    fault: ContextExecutionFault,
}
#[derive(Clone, Copy)]
enum Execution {
    Pathname,
    Bound(BoundTarget),
}
fn preparation_live(execution: Execution) -> bool {
    match execution {
        Execution::Pathname => true,
        Execution::Bound(bound) => Instant::now() < bound.preparation_deadline,
    }
}
// Fixed failure-only parks synchronize with the actual owned deadline. They
// cannot change it, select a caller delay, or grant successful admission.
fn expire_preparation_at(execution: Execution, point: BoundExecutionFault) {
    if let Execution::Bound(bound) = execution {
        if bound.fault == point {
            while Instant::now() < bound.preparation_deadline {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }
}
fn bound_target(
    options: &Options<'_>,
    image: &VerifiedFixtureImage,
    invocation: [u8; 16],
    fault: BoundExecutionFault,
) -> Result<BoundTarget, Failure> {
    let source = image.as_fd().as_raw_fd();
    if !image.matches_invocation(invocation)
        || source <= 3
        || options.stop.as_raw_fd() != 3
        || options.nested_fixture
        || options.stdio.iter().any(|fd| fd.as_raw_fd() == source)
        || options.close_in_init.contains(&source)
    {
        return Err(Failure::InvalidInput);
    }
    let stat = descriptor_stat(source).ok_or(Failure::InvalidInput)?;
    let seals = unsafe { libc::fcntl(source, libc::F_GET_SEALS) };
    if stat.st_mode != libc::S_IFREG | 0o700
        || !(64..=4 * 1024 * 1024).contains(&stat.st_size)
        || seals < 0
        || seals & IMAGE_SEALS != IMAGE_SEALS
        || unsafe { libc::fcntl(source, libc::F_GETFD) } != libc::FD_CLOEXEC
    {
        return Err(Failure::InvalidInput);
    }
    let mut stdio = [descriptor_identity(&stat); 3];
    for (slot, fd) in options.stdio.iter().enumerate() {
        stdio[slot] =
            descriptor_identity(&descriptor_stat(fd.as_raw_fd()).ok_or(Failure::InvalidInput)?);
    }
    Ok(BoundTarget {
        source,
        identity: descriptor_identity(&stat),
        size: stat.st_size,
        seals,
        stdio,
        fault,
        preparation_deadline: image.preparation_deadline(),
        contextual: None,
    })
}
fn close_owned_checked(fd: RawFd) -> bool {
    unsafe {
        libc::close(fd) == 0 && libc::fcntl(fd, libc::F_GETFD) == -1 && errno() == libc::EBADF
    }
}
fn inventory_entry(name: &[u8], scan: RawFd, seen: &mut [bool; 4]) -> bool {
    if name == b"." || name == b".." {
        return true;
    }
    match std::str::from_utf8(name)
        .ok()
        .and_then(|v| v.parse::<RawFd>().ok())
    {
        Some(fd) if fd == scan => true,
        Some(fd @ 0..=3) if !seen[fd as usize] => {
            seen[fd as usize] = true;
            true
        }
        _ => false,
    }
}
fn bound_inventory(target: BoundTarget) -> bool {
    // The directory handle is the only temporary descriptor. Enumerate the
    // complete table, then close and check that handle before restriction.
    let dir = unsafe { libc::opendir(c"/proc/self/fd".as_ptr()) };
    if dir.is_null() {
        return false;
    }
    bound_inventory_scanned(target, dir, false)
}
// A contextual caller preopens this scanner before Landlock. Ownership is
// consumed here; enumeration precedes blanket closure, and no proc grant exists.
fn bound_inventory_scanned(target: BoundTarget, dir: *mut libc::DIR, close_fault: bool) -> bool {
    let scan = unsafe { libc::dirfd(dir) };
    let mut seen = [false; 4];
    let mut valid = scan > 3;
    let mut entries = 0;
    while valid {
        unsafe { *libc::__errno_location() = 0 };
        let entry = unsafe { libc::readdir(dir) };
        if entry.is_null() {
            valid = errno() == 0;
            break;
        }
        entries += 1;
        if entries > 7 {
            valid = false;
            break;
        }
        let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        valid = inventory_entry(name, scan, &mut seen);
    }
    let closed = unsafe { libc::closedir(dir) } == 0
        && unsafe { libc::fcntl(scan, libc::F_GETFD) } == -1
        && errno() == libc::EBADF;
    if !valid || !closed || close_fault || seen != [true; 4] {
        return false;
    }
    for fd in 0..3 {
        if descriptor_stat(fd).map(|stat| descriptor_identity(&stat))
            != Some(target.stdio[fd as usize])
            || unsafe { libc::fcntl(fd, libc::F_GETFD) } != 0
        {
            return false;
        }
    }
    descriptor_stat(3).is_some_and(|stat| {
        descriptor_identity(&stat) == target.identity && stat.st_size == target.size
    }) && unsafe { libc::fcntl(3, libc::F_GETFD) } == libc::FD_CLOEXEC
        && unsafe { libc::fcntl(3, libc::F_GET_SEALS) } == target.seals
}
struct ChildContext<'a, R> {
    argv: &'a [CString],
    argv_ptrs: &'a [*const libc::c_char],
    restrict: Option<R>,
    gate: RawFd,
    parent_gate: RawFd,
    creator: RawFd,
    options: &'a Options<'a>,
    uid: u32,
    gid: u32,
    deadline: Instant,
    groups: &'a [u32],
    execution: Execution,
}
fn die(status: i32) -> ! {
    unsafe { libc::_exit(status) }
}
extern "C" fn child_entry<R: FnOnce() -> Result<(), String>>(ptr: *mut libc::c_void) {
    // The C shim never returns on this branch. The entire address space and descriptor
    // table were copied. No shared Rust references, allocator locks or threads survive.
    let ctx = unsafe { &mut *ptr.cast::<ChildContext<'_, R>>() };
    if !close_checked(ctx.parent_gate) {
        die(125);
    }
    for fd in ctx.options.close_in_init {
        if !close_checked(*fd) {
            die(125);
        }
    }
    if ctx.options.fault == Fault::BeforePdeath
        && (!send(ctx.gate, b'B') || !receive(ctx.gate, b'I', ctx.deadline))
    {
        die(125);
    }
    if ctx.options.fault == Fault::BeforePdeath {
        // Trusted seam: creator dies after releasing this finite registration park.
        // pdeath may attach to the adopter; only the creator pidfd detects the race.
        std::thread::sleep(Duration::from_millis(100));
    }
    if unsafe { libc::getpid() } != 1
        || !pdeath(ctx.creator)
        || !send(ctx.gate, b'P')
        || !receive(ctx.gate, b'M', ctx.deadline)
    {
        die(125);
    }
    if ctx.options.nested_fixture {
        nested_fixture(ctx.uid, ctx.gid, ctx.groups, ctx.deadline);
    }
    if !drop_credentials(ctx.uid, ctx.gid, ctx.groups)
        || !pdeath(ctx.creator)
        || !send(ctx.gate, b'R')
        || !receive(ctx.gate, b'A', ctx.deadline)
        || ready(ctx.creator) != Ok(false)
    {
        die(125);
    }
    expire_preparation_at(ctx.execution, BoundExecutionFault::ReleaseDeadline);
    if !preparation_live(ctx.execution) {
        die(125);
    }
    // Default SIGCHLD and an empty mask ensure waits cannot be silently auto-reaped.
    unsafe {
        if libc::signal(libc::SIGCHLD, libc::SIG_DFL) == libc::SIG_ERR {
            die(125);
        }
        let mut mask: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut mask);
        if libc::sigprocmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut()) != 0 {
            die(125);
        }
    }
    // Recheck at target release as well as in the outside admission gate:
    // scheduling between its acknowledgment and this fork grants no extension.
    if !preparation_live(ctx.execution) {
        die(125);
    }
    let target = unsafe { libc::fork() };
    if target < 0 {
        die(125);
    }
    if target == 0 {
        // These handles are closed even during the restriction closure, not merely
        // marked CLOEXEC. The clone pidfd exists only in the outside verifier.
        if !close_checked(ctx.gate)
            || !close_checked(ctx.creator)
            || !close_checked(ctx.options.stop.as_raw_fd())
        {
            die(125);
        }
        for (to, from) in ctx.options.stdio.iter().enumerate() {
            if unsafe { libc::dup2(from.as_raw_fd(), to as i32) } != to as i32 {
                die(125);
            }
        }
        if let Execution::Bound(bound) = ctx.execution {
            // stop3 was closed and checked above. From now on 3 is the image,
            // so assertions about the old control number being EBADF are invalid.
            if bound.fault == BoundExecutionFault::Dup
                || unsafe { libc::dup3(bound.source, 3, libc::O_CLOEXEC) } != 3
                || !close_owned_checked(bound.source)
            {
                die(125);
            }
            for (slot, fd) in ctx.options.stdio.iter().enumerate() {
                let raw = fd.as_raw_fd();
                if !ctx.options.stdio[..slot]
                    .iter()
                    .any(|v| v.as_raw_fd() == raw)
                    && !close_owned_checked(raw)
                {
                    die(125);
                }
            }
            if bound
                .contextual
                .is_some_and(|c| c.fault == ContextExecutionFault::InitialAlias)
            {
                // A real unexpected alias must be detected by the initial
                // complete inventory, rather than hidden by close_range.
                if unsafe { libc::fcntl(3, libc::F_DUPFD_CLOEXEC, 4) } < 4 {
                    die(125);
                }
            }
            if bound.fault == BoundExecutionFault::Inventory || !bound_inventory(bound) {
                die(125);
            }
        }
        if !preparation_live(ctx.execution) {
            die(125);
        }
        let bound = matches!(ctx.execution, Execution::Bound(_));
        if ctx.restrict.take().unwrap()().is_err() || !deny_namespace_changes(bound) {
            die(125);
        }
        if matches!(ctx.execution, Execution::Bound(b) if b.fault == BoundExecutionFault::CloseRange)
            || unsafe {
                libc::syscall(
                    libc::SYS_close_range,
                    if bound { 4u32 } else { 3u32 },
                    u32::MAX,
                    0u32,
                )
            } != 0
        {
            die(125);
        }
        match ctx.execution {
            Execution::Pathname => unsafe {
                libc::execv(ctx.argv[0].as_ptr(), ctx.argv_ptrs.as_ptr());
            },
            Execution::Bound(bound) => {
                expire_preparation_at(ctx.execution, BoundExecutionFault::ExecDeadline);
                if !preparation_live(ctx.execution) {
                    die(125);
                }
                if bound.fault == BoundExecutionFault::Exec {
                    die(125);
                }
                if let Some(contextual) = bound.contextual {
                    // This storage was completed before clone and is owned by
                    // the captured context throughout the real run. No ambient
                    // environment or post-fork pointer-array allocation is used.
                    unsafe {
                        libc::syscall(
                            libc::SYS_execveat,
                            3,
                            c"".as_ptr(),
                            contextual.argv,
                            contextual.envp,
                            libc::AT_EMPTY_PATH,
                        );
                    }
                    die(125);
                }
                unsafe extern "C" {
                    static environ: *const *const libc::c_char;
                }
                // The fixture driver clears and installs a literal environment.
                // A return is always failure; there is no pathname fallback.
                unsafe {
                    libc::syscall(
                        libc::SYS_execveat,
                        3,
                        c"".as_ptr(),
                        ctx.argv_ptrs.as_ptr(),
                        environ,
                        libc::AT_EMPTY_PATH,
                    );
                }
            }
        }
        die(125);
    }
    if let Execution::Bound(bound) = ctx.execution {
        // The outside verifier still owns its copy through completion/drop.
        // PID 1 needs no executable alias after giving the target its copy.
        if !close_owned_checked(bound.source) {
            die(125);
        }
    }
    unsafe {
        libc::close(ctx.creator);
    }
    // No /proc scan: reap the primary exactly; init's subsequent exit performs
    // kernel namespace teardown, including adopted and nested descendants.
    let mut status = 0;
    loop {
        let r = unsafe { libc::waitpid(target, &mut status, 0) };
        if r == target {
            break;
        }
        if r < 0 && errno() != libc::EINTR {
            die(125);
        }
    }
    let (kind, value) = if libc::WIFEXITED(status) {
        (b'E', libc::WEXITSTATUS(status))
    } else if libc::WIFSIGNALED(status) {
        (b'S', libc::WTERMSIG(status))
    } else {
        (b'F', 125)
    };
    let mut packet = [0u8; 5];
    packet[0] = kind;
    packet[1..].copy_from_slice(&value.to_ne_bytes());
    unsafe {
        libc::send(
            ctx.gate,
            packet.as_ptr().cast(),
            5,
            libc::MSG_NOSIGNAL | libc::MSG_DONTWAIT,
        );
    }
    die(0);
}
fn namespace_filter(bound: bool) -> Option<Vec<libc::sock_filter>> {
    // Complement the existing sandbox: forbid new/joined namespaces even if an
    // unprivileged new user namespace could otherwise restore local capabilities.
    #[cfg(target_arch = "x86_64")]
    let arch = 0xc000003e;
    #[cfg(target_arch = "aarch64")]
    let arch = 0xc00000b7;
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    return None;
    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    {
        let stmt = |code: u16, k| libc::sock_filter {
            code,
            jt: 0,
            jf: 0,
            k,
        };
        let jump = |k, jt, jf| libc::sock_filter {
            code: 0x15,
            jt,
            jf,
            k,
        };
        let mut filter = vec![
            stmt(0x20, 4),
            jump(arch, 1, 0),
            stmt(0x06, libc::SECCOMP_RET_KILL_PROCESS),
            stmt(0x20, 0),
        ];
        if bound {
            filter.extend([
                jump(libc::SYS_memfd_create as u32, 0, 1),
                stmt(0x06, libc::SECCOMP_RET_ERRNO | libc::EPERM as u32),
            ]);
            #[cfg(target_arch = "x86_64")]
            filter.extend([
                jump(libc::SYS_memfd_create as u32 | 0x4000_0000, 0, 1),
                stmt(0x06, libc::SECCOMP_RET_ERRNO | libc::EPERM as u32),
            ]);
        }
        for nr in [libc::SYS_unshare, libc::SYS_setns, libc::SYS_clone3] {
            filter.extend([
                jump(nr as u32, 0, 1),
                stmt(0x06, libc::SECCOMP_RET_ERRNO | libc::EPERM as u32),
            ]);
        }
        let namespaces = libc::CLONE_NEWUSER
            | libc::CLONE_NEWPID
            | libc::CLONE_NEWNS
            | libc::CLONE_NEWUTS
            | libc::CLONE_NEWIPC
            | libc::CLONE_NEWNET
            | libc::CLONE_NEWCGROUP
            | 0x80; // CLONE_NEWTIME
        filter.extend([
            jump(libc::SYS_clone as u32, 0, 3),
            stmt(0x20, 16),
            libc::sock_filter {
                code: 0x45,
                jt: 0,
                jf: 1,
                k: namespaces as u32,
            },
            stmt(0x06, libc::SECCOMP_RET_ERRNO | libc::EPERM as u32),
            stmt(0x06, libc::SECCOMP_RET_ALLOW),
        ]);
        Some(filter)
    }
}
fn deny_namespace_changes(bound: bool) -> bool {
    let Some(mut filter) = namespace_filter(bound) else {
        return false;
    };
    let program = libc::sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_mut_ptr(),
    };
    unsafe {
        libc::prctl(
            libc::PR_SET_SECCOMP,
            libc::SECCOMP_MODE_FILTER,
            &program,
            0,
            0,
        ) == 0
    }
}
fn nested_fixture(uid: u32, gid: u32, groups: &[u32], deadline: Instant) {
    // Actual trusted pre-restriction creation must acknowledge a nested PID 1.
    let [parent, child] = match socketpair() {
        Ok(pair) => pair,
        Err(_) => die(125),
    };
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        die(125);
    }
    if pid == 0 {
        drop(parent);
        // Keep only this private readiness channel, never the outer proof/control.
        if unsafe { libc::dup2(child.as_raw_fd(), 3) } != 3
            || unsafe { libc::syscall(libc::SYS_close_range, 4u32, u32::MAX, 0u32) } != 0
            || unsafe { libc::unshare(libc::CLONE_NEWPID) } != 0
        {
            die(125);
        }
        let nested = unsafe { libc::fork() };
        if nested < 0 || !drop_credentials(uid, gid, groups) {
            die(125);
        }
        if nested == 0 {
            if unsafe { libc::getpid() } != 1 || !send(3, b'N') {
                die(125);
            }
            unsafe {
                libc::close(3);
            }
            std::thread::sleep(Duration::from_secs(5));
            die(0);
        }
        unsafe {
            libc::close(3);
        }
        let mut status = 0;
        unsafe {
            libc::waitpid(nested, &mut status, 0);
        }
        die(0);
    }
    drop(child);
    if !receive(parent.as_raw_fd(), b'N', deadline) {
        die(125);
    }
}

/// # Safety
/// Call only from a fresh single-threaded native fixture process, before starting
/// any threads. Restriction and observer closures are trusted native code, never
/// target input. Observer must register an independent guard before acknowledging
/// Registered; all observer operations must respect the supplied absolute deadline.
/// Stdio must be fresh private fixture descriptors. The restriction closure must
/// apply the existing restrictive Landlock/seccomp policy and child ceilings, or
/// reject execution. The caller supplies no PID and must retain on any unproven
/// result; even a successful token exposes no directory cleanup authority.
pub unsafe fn run<R: FnOnce() -> Result<(), String>>(
    options: Options<'_>,
    restrict: R,
    observer: impl FnMut(Stage, BorrowedFd<'_>, Instant) -> Result<(), Failure>,
) -> Result<ProbeCompletion, Failure> {
    unsafe { run_inner(options, restrict, observer, Execution::Pathname) }
}

/// # Safety
/// All of run's caller requirements apply. The bound fixture caller must use
/// stop fd 3, retain no unknown descriptor aliases, and open policy handles only
/// inside the restriction callback. The driver supplies a cleared literal
/// environment. Only the verified image is retained for initial execution.
pub(crate) unsafe fn run_bound<R: FnOnce() -> Result<(), String>>(
    options: Options<'_>,
    image: VerifiedFixtureImage,
    invocation: [u8; 16],
    restrict: R,
    observer: impl FnMut(Stage, BorrowedFd<'_>, Instant) -> Result<(), Failure>,
) -> Result<BoundProbeCompletion, Failure> {
    unsafe {
        run_bound_fault(
            options,
            image,
            invocation,
            restrict,
            observer,
            BoundExecutionFault::None,
        )
    }
}

/// # Safety
/// Identical to run_bound. This finite fixture seam can force failure only.
pub(crate) unsafe fn run_bound_fault<R: FnOnce() -> Result<(), String>>(
    options: Options<'_>,
    image: VerifiedFixtureImage,
    invocation: [u8; 16],
    restrict: R,
    observer: impl FnMut(Stage, BorrowedFd<'_>, Instant) -> Result<(), Failure>,
    fault: BoundExecutionFault,
) -> Result<BoundProbeCompletion, Failure> {
    // The image owns the preparation deadline. No run option renews it.
    if fault == BoundExecutionFault::EntryDeadline {
        while Instant::now() < image.preparation_deadline() {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    if Instant::now() >= image.preparation_deadline()
        || ready(options.stop.as_raw_fd()) != Ok(false)
    {
        return Err(Failure::Admission);
    }
    validate(&options)?;
    let target = bound_target(&options, &image, invocation, fault)?;
    let completion = unsafe { run_inner(options, restrict, observer, Execution::Bound(target)) }?;
    Ok(BoundProbeCompletion {
        completion,
        image,
        invocation,
    })
}

// Contextual entry has no caller restriction closure, policy parser or keep-list.
// The actual outside capture is completed and checked-closed before clone.
pub(crate) unsafe fn run_context_bound(
    options: Options<'_>,
    image: VerifiedFixtureImage,
    plan: FixtureContextPlan,
    observer: impl FnMut(Stage, BorrowedFd<'_>, Instant) -> Result<(), Failure>,
) -> Result<ContextFixtureCompletion, Failure> {
    unsafe {
        run_context_bound_fault(
            options,
            image,
            plan,
            observer,
            ContextFault::None,
            BoundExecutionFault::None,
            ContextExecutionFault::None,
            |_| Ok(()),
        )
    }
}

/// # Safety
/// Call in the same fresh single-threaded fixture process as run_bound, with its
/// exact owned transport layout. Finite seams can mutate retained fixture data or
/// force failure; none can supply captured metadata, grants or completion.
pub(crate) unsafe fn run_context_bound_fault(
    options: Options<'_>,
    image: VerifiedFixtureImage,
    plan: FixtureContextPlan,
    observer: impl FnMut(Stage, BorrowedFd<'_>, Instant) -> Result<(), Failure>,
    context_fault: ContextFault,
    image_fault: BoundExecutionFault,
    execution_fault: ContextExecutionFault,
    mut context_observer: impl FnMut(ContextStage) -> Result<(), ContextFailure>,
) -> Result<ContextFixtureCompletion, Failure> {
    let invocation = plan.invocation();
    if image_fault == BoundExecutionFault::EntryDeadline {
        while Instant::now() < image.preparation_deadline() {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    if Instant::now() >= image.preparation_deadline()
        || ready(options.stop.as_raw_fd()) != Ok(false)
    {
        return Err(Failure::Admission);
    }
    validate(&options)?;
    let mut target = bound_target(&options, &image, invocation, image_fault)?;
    let context = crate::probe_context::capture_context_observed(
        plan,
        options.stop,
        image.preparation_deadline(),
        context_fault,
        &mut context_observer,
    )
    .map_err(|failure| match failure {
        ContextFailure::InvalidInput => Failure::InvalidInput,
        _ => Failure::Admission,
    })?;
    // Capture owns the immutable CString allocations and pointer arrays. It
    // outlives run_inner; fork receives independent copies of that address space.
    target.contextual = Some(ContextExecStorage {
        argv: context.argv_ptrs().as_ptr(),
        envp: context.envp().as_ptr(),
        fault: execution_fault,
    });
    let restrict = || {
        // This dedicated scanner is preopened while proc is still accessible;
        // it receives no Landlock grant and is consumed by the final inventory.
        let scan = unsafe { libc::opendir(c"/proc/self/fd".as_ptr()) };
        if scan.is_null() {
            return Err("context descriptor scanner unavailable".into());
        }
        let scan_number = unsafe { libc::dirfd(scan) };
        if scan_number <= 3 {
            unsafe {
                libc::closedir(scan);
            }
            return Err("context descriptor scanner overlaps reserved image".into());
        }
        let result = context.setup_observed(
            image.preparation_deadline(),
            context_fault,
            &mut context_observer,
        );
        if result.is_err() {
            let _closed = unsafe { libc::closedir(scan) } == 0
                && unsafe { libc::fcntl(scan_number, libc::F_GETFD) } == -1
                && errno() == libc::EBADF;
            return Err("context restriction or revalidation failed".into());
        }
        if execution_fault == ContextExecutionFault::FinalAlias
            && unsafe { libc::fcntl(3, libc::F_DUPFD_CLOEXEC, 4) } < 4
        {
            let _ = unsafe { libc::closedir(scan) };
            return Err("context alias fault failed".into());
        }
        if !bound_inventory_scanned(
            target,
            scan,
            execution_fault == ContextExecutionFault::ScannerClose,
        ) {
            return Err("context final descriptor inventory failed".into());
        }
        Ok(())
    };
    let completion = unsafe { run_inner(options, restrict, observer, Execution::Bound(target)) }?;
    Ok(ContextFixtureCompletion {
        completion,
        image,
        context,
        invocation,
    })
}
unsafe fn run_inner<R: FnOnce() -> Result<(), String>>(
    options: Options<'_>,
    restrict: R,
    mut observer: impl FnMut(Stage, BorrowedFd<'_>, Instant) -> Result<(), Failure>,
    execution: Execution,
) -> Result<ProbeCompletion, Failure> {
    use std::os::fd::AsFd;
    if !preparation_live(execution) {
        return Err(Failure::Admission);
    }
    let argv = validate(&options)?;
    let argv_ptrs: Vec<*const libc::c_char> = argv
        .iter()
        .map(|a| a.as_ptr())
        .chain(std::iter::once(std::ptr::null()))
        .collect();
    let (uid, gid) = identity()?;
    // Unprivileged single-ID gid_map requires setgroups=deny. Linux prohibits
    // clearing groups both before that mapping and after deny. Preserve the exact
    // inherited list, verify its mapped representation, and rely on the required
    // Landlock allowlist for filesystem access. No subordinate group is mapped.
    let overflow_gid = std::fs::read_to_string("/proc/sys/kernel/overflowgid")
        .map_err(|_| Failure::Admission)?
        .trim()
        .parse::<u32>()
        .map_err(|_| Failure::Admission)?;
    let groups: Vec<u32> = supplementary_groups()?
        .into_iter()
        .map(|g| if g == gid { gid } else { overflow_gid })
        .collect();
    if options.fault == Fault::CreatorPidfd {
        return Err(Failure::Unsupported(libc::ENOSYS));
    }
    let creator = owned(unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) } as i32)?;
    let [parent_gate, child_gate] = socketpair()?;
    let deadline = Instant::now() + options.wall;
    if ready(options.stop.as_raw_fd()) != Ok(false) {
        return Err(Failure::Admission);
    }
    if options.fault == Fault::Clone {
        return Err(Failure::Unsupported(libc::ENOSYS));
    }
    // Prevent inherited SIGCHLD=SIG_IGN/SA_NOCLDWAIT from defeating exact waiting.
    if unsafe { libc::signal(libc::SIGCHLD, libc::SIG_DFL) } == libc::SIG_ERR {
        return Err(Failure::Admission);
    }
    let mut context = ChildContext {
        argv: &argv,
        argv_ptrs: &argv_ptrs,
        restrict: Some(restrict),
        gate: child_gate.as_raw_fd(),
        parent_gate: parent_gate.as_raw_fd(),
        creator: creator.as_raw_fd(),
        options: &options,
        uid,
        gid,
        deadline,
        groups: &groups,
        execution,
    };
    let mut fd = -1;
    expire_preparation_at(execution, BoundExecutionFault::PreCloneDeadline);
    if !preparation_live(execution)
        || (matches!(execution, Execution::Bound(_))
            && ready(options.stop.as_raw_fd()) != Ok(false))
    {
        return Err(Failure::Admission);
    }
    let pid = unsafe {
        gs_probe_clone(
            &mut fd,
            child_entry::<R>,
            (&mut context as *mut ChildContext<'_, R>).cast(),
        )
    };
    if pid < 0 {
        return Err(Failure::Unsupported(errno()));
    }
    let init = OwnedInit { fd: owned(fd)? };
    drop(child_gate);
    let admission = (|| {
        observer(Stage::Registered, init.fd.as_fd(), deadline)?;
        if options.fault == Fault::BeforePdeath {
            if !receive(parent_gate.as_raw_fd(), b'B', deadline) {
                return Err(Failure::Admission);
            }
            if !send(parent_gate.as_raw_fd(), b'I') {
                return Err(Failure::Admission);
            }
            observer(Stage::BeforeRegistration, init.fd.as_fd(), deadline)?;
        }
        if !receive(parent_gate.as_raw_fd(), b'P', deadline) {
            return Err(Failure::Admission);
        }
        observer(Stage::Mapping, init.fd.as_fd(), deadline)?;
        if options.fault == Fault::Mapping {
            return Err(Failure::Admission);
        }
        mappings(pid as i32, uid, gid)?;
        if !send(parent_gate.as_raw_fd(), b'M') || !receive(parent_gate.as_raw_fd(), b'R', deadline)
        {
            return Err(Failure::Admission);
        }
        observer(Stage::Gate, init.fd.as_fd(), deadline)?;
        expire_preparation_at(execution, BoundExecutionFault::GateDeadline);
        if !preparation_live(execution)
            || Instant::now() >= deadline
            || ready(options.stop.as_raw_fd()) != Ok(false)
            || !send(parent_gate.as_raw_fd(), b'A')
        {
            return Err(Failure::Admission);
        }
        observer(Stage::Admitted, init.fd.as_fd(), deadline)
    })();
    // A failed setup closes the gate permanently; successful init retains a tiny
    // outcome channel that the target closed before restriction and exec.
    if admission.is_err() {
        unsafe {
            libc::shutdown(parent_gate.as_raw_fd(), libc::SHUT_WR);
        }
    }
    let mut stopped = admission.is_err();
    let mut stop_deadline = if stopped {
        signal_init(init.fd.as_fd());
        Some(Instant::now() + options.observation)
    } else {
        None
    };
    loop {
        if options.fault != Fault::WithholdWait && options.fault != Fault::Wait {
            match exact_reap(init.fd.as_fd()) {
                Ok(Some((code, status))) => {
                    let mut packet = [0u8; 6];
                    let n = unsafe {
                        libc::recv(
                            parent_gate.as_raw_fd(),
                            packet.as_mut_ptr().cast(),
                            6,
                            libc::MSG_DONTWAIT,
                        )
                    };
                    let outcome = if admission.is_err() {
                        Outcome::SetupFailed
                    } else if stopped {
                        Outcome::Stopped
                    } else if code != libc::CLD_EXITED {
                        Outcome::Signalled(status)
                    } else if status != 0 || n != 5 {
                        Outcome::SetupFailed
                    } else {
                        let value = i32::from_ne_bytes(packet[1..5].try_into().unwrap());
                        match packet[0] {
                            b'E' if value == 125 => Outcome::SetupFailed,
                            b'E' if (0..=255).contains(&value) => Outcome::Exited(value),
                            b'S' if (1..=64).contains(&value) => Outcome::Signalled(value),
                            _ => Outcome::SetupFailed,
                        }
                    };
                    return Ok(ProbeCompletion {
                        outcome,
                        termination: NamespaceTermination { _private: () },
                    });
                }
                Err(_) => {
                    signal_init(init.fd.as_fd());
                    return Err(Failure::TerminationUnproven);
                }
                Ok(None) => {}
            }
        } else if options.fault == Fault::Wait {
            signal_init(init.fd.as_fd());
            return Err(Failure::TerminationUnproven);
        }
        let control = if options.fault == Fault::ControlError {
            Err(Failure::Admission)
        } else {
            ready(options.stop.as_raw_fd())
        };
        if !stopped && (Instant::now() >= deadline || control != Ok(false)) {
            stopped = true;
            signal_init(init.fd.as_fd());
            stop_deadline = Some(Instant::now() + options.observation);
        }
        if stop_deadline.is_some_and(|d| Instant::now() >= d) {
            return Err(Failure::TerminationUnproven);
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::AsFd;

    #[test]
    #[cfg(probe_clone_unavailable)]
    fn missing_clone_shim_refuses_without_calling_the_child() {
        extern "C" fn must_not_run(_: *mut libc::c_void) {
            panic!("unavailable clone shim invoked a child");
        }
        let mut pidfd = -1;
        assert_eq!(
            unsafe { gs_probe_clone(&mut pidfd, must_not_run, std::ptr::null_mut()) },
            -1
        );
        assert_eq!(pidfd, -1);
        assert_eq!(errno(), libc::ENOSYS);
    }

    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    fn filter_decision(filter: &[libc::sock_filter], arch: u32, nr: u32, flags: u32) -> u32 {
        let mut accumulator = 0;
        let mut pc = 0;
        for _ in 0..filter.len() {
            let instruction = filter[pc];
            match instruction.code {
                0x20 => {
                    accumulator = match instruction.k {
                        0 => nr,
                        4 => arch,
                        16 => flags,
                        _ => panic!("unexpected seccomp load"),
                    };
                    pc += 1;
                }
                0x15 | 0x45 => {
                    let condition = if instruction.code == 0x15 {
                        accumulator == instruction.k
                    } else {
                        accumulator & instruction.k != 0
                    };
                    pc += 1 + if condition {
                        instruction.jt
                    } else {
                        instruction.jf
                    } as usize;
                }
                0x06 => return instruction.k,
                _ => panic!("unexpected seccomp instruction"),
            }
        }
        panic!("seccomp program failed to return")
    }

    #[test]
    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    fn bound_filter_denies_memfd_and_preserves_namespace_decisions() {
        #[cfg(target_arch = "x86_64")]
        let arch = 0xc000003e;
        #[cfg(target_arch = "aarch64")]
        let arch = 0xc00000b7;
        let unbound = namespace_filter(false).unwrap();
        let bound = namespace_filter(true).unwrap();
        let denied = libc::SECCOMP_RET_ERRNO | libc::EPERM as u32;
        assert_eq!(unbound.len(), 15);
        assert_eq!(
            filter_decision(&unbound, arch, libc::SYS_memfd_create as u32, 0),
            libc::SECCOMP_RET_ALLOW
        );
        assert_eq!(
            filter_decision(&bound, arch, libc::SYS_memfd_create as u32, 0),
            denied
        );
        let namespace_flags = [
            libc::CLONE_NEWUSER,
            libc::CLONE_NEWPID,
            libc::CLONE_NEWNS,
            libc::CLONE_NEWUTS,
            libc::CLONE_NEWIPC,
            libc::CLONE_NEWNET,
            libc::CLONE_NEWCGROUP,
            0x80,
        ];
        for filter in [&unbound, &bound] {
            for syscall in [libc::SYS_unshare, libc::SYS_setns, libc::SYS_clone3] {
                assert_eq!(filter_decision(filter, arch, syscall as u32, 0), denied);
            }
            for flags in namespace_flags {
                assert_eq!(
                    filter_decision(filter, arch, libc::SYS_clone as u32, flags as u32),
                    denied
                );
            }
            for flags in [0, libc::SIGCHLD, libc::CLONE_VM | libc::CLONE_FILES] {
                assert_eq!(
                    filter_decision(filter, arch, libc::SYS_clone as u32, flags as u32),
                    libc::SECCOMP_RET_ALLOW
                );
            }
            assert_eq!(
                filter_decision(filter, arch, libc::SYS_read as u32, 0),
                libc::SECCOMP_RET_ALLOW
            );
            assert_eq!(
                filter_decision(filter, arch ^ 1, libc::SYS_memfd_create as u32, 0),
                libc::SECCOMP_RET_KILL_PROCESS
            );
        }
    }

    #[test]
    #[cfg(target_arch = "x86_64")]
    fn bound_filter_denies_x32_memfd_and_kills_compat_arch() {
        let filter = namespace_filter(true).unwrap();
        assert_eq!(
            filter_decision(&filter, 0xc000003e, 319 | 0x40000000, 0),
            libc::SECCOMP_RET_ERRNO | libc::EPERM as u32
        );
        // i386's own memfd syscall number must never reach the native allow tail.
        assert_eq!(
            filter_decision(&filter, 0x40000003, 356, 0),
            libc::SECCOMP_RET_KILL_PROCESS
        );
        assert_eq!(
            filter_decision(&filter, 0xc00000b7, 279, 0),
            libc::SECCOMP_RET_KILL_PROCESS
        );
    }

    #[test]
    fn descriptor_identity_tracks_aliases_without_trusting_raw_numbers() {
        // The native close inventory requires a fresh single-threaded process.
        // Isolate descriptor-reuse checks from parallel unit-fixture allocations.
        if std::env::var_os("GS_LIFETIME_ALIAS_CHILD").is_none() {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "probe_lifetime::tests::descriptor_identity_tracks_aliases_without_trusting_raw_numbers"])
                .env("GS_LIFETIME_ALIAS_CHILD", "1")
                .spawn().unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(status.success());
                    return;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            let _ = child.kill();
            panic!("descriptor inventory unit watchdog expired");
        }
        let file = std::fs::File::open("/dev/null").unwrap();
        let alias = file.try_clone().unwrap();
        assert_ne!(file.as_raw_fd(), alias.as_raw_fd());
        assert_eq!(
            descriptor_identity(&descriptor_stat(file.as_raw_fd()).unwrap()),
            descriptor_identity(&descriptor_stat(alias.as_raw_fd()).unwrap()),
        );
        let raw = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
        assert!(raw >= 64);
        assert!(close_owned_checked(raw));
        assert!(!close_owned_checked(raw));
    }

    #[test]
    fn inventory_allows_only_stdio_image_and_temporary_scan_handle() {
        let mut seen = [false; 4];
        // Reused fd 3 is the image, and the scan may reuse a closed high alias.
        for name in [b".".as_slice(), b"..", b"3", b"1", b"9", b"0", b"2"] {
            assert!(inventory_entry(name, 9, &mut seen));
        }
        assert_eq!(seen, [true; 4]);
        for unexpected in [
            b"4".as_slice(),
            b"10",
            b"-1",
            b"junk",
            b"2147483648",
            b"\xff",
        ] {
            assert!(!inventory_entry(unexpected, 9, &mut [false; 4]));
        }
        assert!(!inventory_entry(b"3", 9, &mut seen));
        let mut missing = [false; 4];
        for name in [b"0".as_slice(), b"1", b"2", b"9"] {
            assert!(inventory_entry(name, 9, &mut missing));
        }
        assert_ne!(missing, [true; 4]);
    }
    #[test]
    fn rejects_unbounded_or_malformed_input_without_creation() {
        let fd = std::fs::File::open("/dev/null").unwrap();
        for argv in [
            vec![],
            vec!["relative".into()],
            vec!["/a\0b".into()],
            vec!["/x".repeat(9000)],
            vec!["/x".into(); 33],
        ] {
            let o = Options {
                argv: &argv,
                stop: fd.as_fd(),
                stdio: [fd.as_fd(); 3],
                wall: Duration::from_secs(1),
                observation: Duration::from_secs(1),
                fault: Fault::None,
                nested_fixture: false,
                close_in_init: &[],
            };
            assert_eq!(validate(&o).unwrap_err(), Failure::InvalidInput);
        }
        for wall in [Duration::ZERO, Duration::from_secs(11)] {
            let argv = vec!["/x".into()];
            let o = Options {
                argv: &argv,
                stop: fd.as_fd(),
                stdio: [fd.as_fd(); 3],
                wall,
                observation: Duration::from_secs(1),
                fault: Fault::None,
                nested_fixture: false,
                close_in_init: &[],
            };
            assert_eq!(validate(&o).unwrap_err(), Failure::InvalidInput);
        }
    }
    #[test]
    fn ordinary_pidfd_or_stdout_cannot_be_a_namespace_proof() {
        let fd = std::fs::File::open("/dev/null").unwrap();
        assert_eq!(exact_reap(fd.as_fd()), Err(Failure::TerminationUnproven));
        assert!(!signal_init(fd.as_fd()));
    }

    #[test]
    fn a_stop_descriptor_cannot_be_exposed_as_target_stdio() {
        let stop = std::fs::File::open("/dev/null").unwrap();
        let stdio = std::fs::File::open("/dev/null").unwrap();
        let argv = vec!["/fixture".into()];
        for slot in 0..3 {
            let mut descriptors = [stdio.as_fd(); 3];
            descriptors[slot] = stop.as_fd();
            let options = Options {
                argv: &argv,
                stop: stop.as_fd(),
                stdio: descriptors,
                wall: Duration::from_secs(1),
                observation: Duration::from_secs(1),
                fault: Fault::None,
                nested_fixture: false,
                close_in_init: &[],
            };
            assert_eq!(validate(&options).unwrap_err(), Failure::InvalidInput);
        }
    }
}
