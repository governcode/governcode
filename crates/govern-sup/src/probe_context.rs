//! Feature-only observational context binding for a fixed native fixture.
//! Selection is not authority. Only outside observations supply the owner gate;
//! target ownership comparisons use the captured namespace translation.

use std::cell::{Cell, RefCell};
use std::ffi::{CStr, CString};
use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};
use std::path::PathBuf;
use std::time::Instant;

use crate::policy::{ChildLimits, ChildRestrictions, Kind, Resolved, Rule};

const LEAVES: [&str; 9] = [
    "cwd", "home", "config", "cache", "data", "state", "runtime", "tmp", "empty",
];
const MAX_ROOT: usize = 3115;
const MAX_PARENT: usize = 3072;
const MAX_LEAF: usize = 3123;
const MAX_PAYLOAD: usize = 48 * 1024;
const LIMITS: ChildLimits = ChildLimits {
    cpu_seconds: 2,
    address_space_bytes: 64 * 1024 * 1024,
    open_files: 32,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ContextFailure {
    InvalidInput,
    Maps,
    OverflowCollision,
    UnsafeDirectory,
    Changed,
    Content,
    Filesystem,
    Close,
    Stopped,
    Deadline,
    Restriction,
    Injected,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ContextStage {
    BeforeCapture,
    CaptureWalk,
    CaptureEnumeration,
    CaptureSecondPass,
    AfterCapture,
    BeforeAcquisition,
    AcquisitionWalk,
    AcquisitionEnumeration,
    AfterAcquisition,
    BeforeLandlock,
    AfterLandlock,
    RevalidationWalk,
    RevalidationEnumeration,
    BeforeClosure,
    AfterClosure,
}
/// Finite trusted seams: none can manufacture observations or successful checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ContextFault {
    None,
    Fail(ContextStage),
    Deadline(ContextStage),
    Expire(ContextStage),
    CloseFirst,
    Open,
    Stat,
    Fchdir,
    Rules,
    Limits,
    Revalidate,
    Close,
    CloseFinal,
    CaptureDeadline,
    AcquireDeadline,
    EnumerationDeadline,
    RulesDeadline,
    RevalidationDeadline,
    ClosureDeadline,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Identity {
    dev: u64,
    ino: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Observation {
    id: Identity,
    mode: u32,
    uid: u32,
    gid: u32,
    ctime: i64,
    ctime_nsec: i64,
}
impl Observation {
    fn of(s: &libc::stat) -> Self {
        Self {
            id: Identity {
                dev: s.st_dev,
                ino: s.st_ino,
            },
            mode: s.st_mode,
            uid: s.st_uid,
            gid: s.st_gid,
            ctime: s.st_ctime,
            ctime_nsec: s.st_ctime_nsec,
        }
    }
}
fn safe_ancestor(s: Observation, uid: u32) -> bool {
    s.mode & libc::S_IFMT == libc::S_IFDIR
        && (s.uid == 0 || s.uid == uid)
        && (s.mode & 0o022 == 0 || (s.uid == 0 && s.mode & 0o1000 != 0))
}
fn private_directory(s: Observation, uid: u32) -> bool {
    s.mode & libc::S_IFMT == libc::S_IFDIR && s.uid == uid && s.mode & 0o7777 == 0o700
}
fn translated(id: u32, creator: u32, overflow: u32) -> u32 {
    if id == creator { creator } else { overflow }
}
fn canonical_u64(s: &str) -> Result<u64, ContextFailure> {
    if s.is_empty()
        || s.len() > 20
        || (s.len() > 1 && s.starts_with('0'))
        || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(ContextFailure::InvalidInput);
    }
    s.parse().map_err(|_| ContextFailure::InvalidInput)
}
fn canonical_path(path: &str, limit: usize) -> bool {
    path.len() <= limit
        && path.starts_with('/')
        && path.len() > 1
        && !path.contains(':')
        && !path.chars().any(char::is_control)
        && path[1..]
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != ".." && p.len() <= 255)
}

/// Owns only bounded caller selection and immutable, native-generated exec storage.
/// There is deliberately no deserializer, raw-FD constructor or validation setter.
#[derive(Debug)]
pub(crate) struct FixtureContextPlan {
    root: String,
    components: Vec<CString>,
    ids: [Identity; 10],
    invocation: [u8; 16],
    argv: [CString; 25],
    argv_ptrs: [*const libc::c_char; 26],
    env: [CString; 14],
    envp: [*const libc::c_char; 15],
}
impl FixtureContextPlan {
    pub(crate) fn parse(
        root: &str,
        ids: &[String],
        invocation: [u8; 16],
        target_mode: &str,
    ) -> Result<Self, ContextFailure> {
        if !canonical_path(root, MAX_ROOT)
            || ids.len() != 20
            || !matches!(
                target_mode,
                "normal"
                    | "high-exit"
                    | "signal"
                    | "cpu"
                    | "sandbox"
                    | "hold"
                    | "acp"
                    | "acp-forbidden"
                    | "acp-hang"
                    | "forge"
                    | "direct"
                    | "double"
                    | "detach"
                    | "signal-tree"
                    | "stdout-flood"
                    | "stderr-flood"
            )
        {
            return Err(ContextFailure::InvalidInput);
        }
        let (parent, _) = root.rsplit_once('/').ok_or(ContextFailure::InvalidInput)?;
        if !canonical_path(parent, MAX_PARENT)
            || LEAVES.iter().any(|n| root.len() + 1 + n.len() > MAX_LEAF)
        {
            return Err(ContextFailure::InvalidInput);
        }
        let values = ids
            .iter()
            .map(|s| canonical_u64(s))
            .collect::<Result<Vec<_>, _>>()?;
        let selected: [Identity; 10] = std::array::from_fn(|i| Identity {
            dev: values[2 * i],
            ino: values[2 * i + 1],
        });
        if selected
            .iter()
            .enumerate()
            .any(|(i, id)| selected[..i].contains(id))
        {
            return Err(ContextFailure::InvalidInput);
        }
        let components = root[1..]
            .split('/')
            .map(|s| CString::new(s).unwrap())
            .collect();
        let hex = invocation
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let mut args = vec![
            "sealed-context-fixture".to_owned(),
            "context".to_owned(),
            hex,
            root.to_owned(),
        ];
        args.extend(values.iter().map(u64::to_string));
        args.push(target_mode.to_owned());
        let argv: [CString; 25] = args
            .into_iter()
            .map(|s| CString::new(s).unwrap())
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();
        let fields = [
            ("HOME", "home"),
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_CACHE_HOME", "cache"),
            ("XDG_DATA_HOME", "data"),
            ("XDG_STATE_HOME", "state"),
            ("XDG_RUNTIME_DIR", "runtime"),
            ("XDG_CONFIG_DIRS", "empty"),
            ("XDG_DATA_DIRS", "empty"),
            ("TMPDIR", "tmp"),
            ("TMP", "tmp"),
            ("TEMP", "tmp"),
            ("PATH", "empty"),
            ("LANG", "C"),
            ("LC_ALL", "C"),
        ];
        let env: [CString; 14] = std::array::from_fn(|i| {
            let (key, leaf) = fields[i];
            CString::new(if i < 12 {
                format!("{key}={root}/{leaf}")
            } else {
                format!("{key}=C")
            })
            .unwrap()
        });
        if env
            .iter()
            .map(|s| s.as_bytes_with_nul().len())
            .sum::<usize>()
            > MAX_PAYLOAD
            || argv
                .iter()
                .map(|s| s.as_bytes_with_nul().len())
                .sum::<usize>()
                > MAX_PAYLOAD
        {
            return Err(ContextFailure::InvalidInput);
        }
        // CString allocations are finished before pointers are taken. Moving the
        // arrays/plan does not move the CString byte allocations; no setters exist.
        let argv_ptrs = std::array::from_fn(|i| {
            if i < 25 {
                argv[i].as_ptr()
            } else {
                std::ptr::null()
            }
        });
        let envp = std::array::from_fn(|i| {
            if i < 14 {
                env[i].as_ptr()
            } else {
                std::ptr::null()
            }
        });
        Ok(Self {
            root: root.into(),
            components,
            ids: selected,
            invocation,
            argv,
            argv_ptrs,
            env,
            envp,
        })
    }
    pub(crate) fn argv(&self) -> &[CString] {
        &self.argv
    }
    pub(crate) fn argv_ptrs(&self) -> &[*const libc::c_char; 26] {
        &self.argv_ptrs
    }
    pub(crate) fn envp(&self) -> &[*const libc::c_char; 15] {
        &self.envp
    }
    pub(crate) fn invocation(&self) -> [u8; 16] {
        self.invocation
    }
    pub(crate) fn root(&self) -> &str {
        &self.root
    }

    fn capture_observations(
        &self,
        budget: &Budget<'_>,
    ) -> Result<ContextObservations, ContextFailure> {
        let fault = budget.fault;
        budget.check(ContextStage::BeforeCapture)?;

        let (uid, gid, overflow_uid, overflow_gid) = outer_identity(&budget)?;
        let mut fds = Fds::new(fault);
        let mut observations = Vec::with_capacity(self.components.len() + 10);
        let result = (|| {
            rooted_walk(
                self,
                &budget,
                &mut fds,
                false,
                ContextStage::CaptureWalk,
                |index, s| {
                    if !safe_ancestor(s, uid)
                        || (index >= self.components.len() - 1 && !private_directory(s, uid))
                    {
                        return Err(ContextFailure::UnsafeDirectory);
                    }
                    if index == self.components.len() && s.id != self.ids[0] {
                        return Err(ContextFailure::Changed);
                    }
                    observations.push(s);
                    Ok(())
                },
            )?;
            enumerate(
                fds.raw(10),
                true,
                &budget,
                ContextStage::CaptureEnumeration,
                &mut fds.closer,
            )?;
            for (i, name) in LEAVES.iter().enumerate() {
                budget.check(ContextStage::CaptureWalk)?;
                fds.put(
                    11,
                    open_at(fds.raw(10), &CString::new(*name).unwrap(), false)?,
                )?;
                let s = observe_checked(fds.raw(11), fault)?;
                if !private_directory(s, uid) {
                    return Err(ContextFailure::UnsafeDirectory);
                }
                if s.id != self.ids[i + 1] {
                    return Err(ContextFailure::Changed);
                }
                observations.push(s);
                enumerate(
                    fds.raw(11),
                    false,
                    &budget,
                    ContextStage::CaptureEnumeration,
                    &mut fds.closer,
                )?;
                fds.close(11)?;
            }
            fds.close(10)?;
            // A fixed fresh rooted pass, never a retry-until-stable loop.
            rooted_walk(
                self,
                &budget,
                &mut fds,
                false,
                ContextStage::CaptureSecondPass,
                |i, s| {
                    if observations[i] != s {
                        Err(ContextFailure::Changed)
                    } else {
                        Ok(())
                    }
                },
            )?;
            enumerate(
                fds.raw(10),
                true,
                &budget,
                ContextStage::CaptureSecondPass,
                &mut fds.closer,
            )?;
            for (i, name) in LEAVES.iter().enumerate() {
                budget.check(ContextStage::CaptureSecondPass)?;
                fds.put(
                    11,
                    open_at(fds.raw(10), &CString::new(*name).unwrap(), false)?,
                )?;
                if observe(fds.raw(11))? != observations[self.components.len() + 1 + i] {
                    return Err(ContextFailure::Changed);
                }
                enumerate(
                    fds.raw(11),
                    false,
                    &budget,
                    ContextStage::CaptureSecondPass,
                    &mut fds.closer,
                )?;
                fds.close(11)?;
            }
            Ok(())
        })();
        finish(result, fds.close_all())?;
        budget.check(ContextStage::AfterCapture)?;

        budget.check(ContextStage::AfterCapture)?;
        Ok(ContextObservations {
            root: self.root.clone(),
            ids: self.ids,
            invocation: self.invocation,
            observations,
            uid,
            gid,
            overflow_uid,
            overflow_gid,
        })
    }
}

type Observer<'a> = &'a mut dyn FnMut(ContextStage) -> Result<(), ContextFailure>;
struct Budget<'a> {
    stop: Option<BorrowedFd<'a>>,
    deadline: Instant,
    fault: ContextFault,
    observer: RefCell<Option<Observer<'a>>>,
    seen: Cell<u32>,
}
impl<'a> Budget<'a> {
    fn new(
        stop: Option<BorrowedFd<'a>>,
        deadline: Instant,
        fault: ContextFault,
        observer: Option<Observer<'a>>,
    ) -> Self {
        Self {
            stop,
            deadline,
            fault,
            observer: RefCell::new(observer),
            seen: Cell::new(0),
        }
    }
}
impl Budget<'_> {
    fn check(&self, stage: ContextStage) -> Result<(), ContextFailure> {
        if self.fault == ContextFault::Expire(stage) {
            // Park only until the original absolute clock, polling stop solely
            // outside. No new deadline is constructed and no signal is consumed.
            while Instant::now() < self.deadline {
                self.check_stop()?;
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
        if self.fault == ContextFault::Open && matches!(stage, ContextStage::AcquisitionWalk) {
            return Err(ContextFailure::Filesystem);
        }
        if Instant::now() >= self.deadline
            || self.fault == ContextFault::Deadline(stage)
            || matches!(
                (self.fault, stage),
                (ContextFault::CaptureDeadline, ContextStage::BeforeCapture)
                    | (
                        ContextFault::AcquireDeadline,
                        ContextStage::BeforeAcquisition
                    )
                    | (
                        ContextFault::EnumerationDeadline,
                        ContextStage::CaptureEnumeration
                            | ContextStage::AcquisitionEnumeration
                            | ContextStage::RevalidationEnumeration
                    )
                    | (ContextFault::RulesDeadline, ContextStage::BeforeLandlock)
                    | (
                        ContextFault::RevalidationDeadline,
                        ContextStage::RevalidationWalk
                    )
                    | (ContextFault::ClosureDeadline, ContextStage::BeforeClosure)
            )
        {
            return Err(ContextFailure::Deadline);
        }
        if self.fault == ContextFault::Fail(stage) {
            return Err(ContextFailure::Injected);
        }
        // Target setup never polls fd 3, which now names the sealed executable.
        self.check_stop()?;
        let bit = 1u32 << stage as u32;
        if self.seen.get() & bit == 0 {
            self.seen.set(self.seen.get() | bit);
            if let Some(observer) = self.observer.borrow_mut().as_mut() {
                observer(stage)?;
            }
            self.check_stop()?;
            // A trusted observer still receives no validation authority or clock renewal.
            if Instant::now() >= self.deadline {
                return Err(ContextFailure::Deadline);
            }
        }
        Ok(())
    }
    fn check_stop(&self) -> Result<(), ContextFailure> {
        if let Some(stop) = self.stop {
            let mut p = libc::pollfd {
                fd: stop.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            if unsafe { libc::poll(&mut p, 1, 0) } != 0 {
                return Err(ContextFailure::Stopped);
            }
        }
        Ok(())
    }
}

/// Every owner is consumed before close; all remaining owners are attempted after
/// any error. Linux close is never retried, even if its result reports failure.
struct Closer {
    inject_first: bool,
    attempts: usize,
}
impl Closer {
    fn close(&mut self, fd: OwnedFd) -> Result<(), ContextFailure> {
        self.attempts += 1;
        let actual = unsafe { libc::close(fd.into_raw_fd()) };
        let injected = std::mem::take(&mut self.inject_first);
        if actual != 0 || injected {
            Err(ContextFailure::Close)
        } else {
            Ok(())
        }
    }
}
struct Fds {
    slots: [Option<OwnedFd>; 12],
    closer: Closer,
}
impl Fds {
    fn new(fault: ContextFault) -> Self {
        Self {
            slots: std::array::from_fn(|_| None),
            closer: Closer {
                inject_first: matches!(fault, ContextFault::CloseFirst),
                attempts: 0,
            },
        }
    }
    fn raw(&self, i: usize) -> RawFd {
        self.slots[i].as_ref().unwrap().as_raw_fd()
    }
    fn put(&mut self, i: usize, fd: OwnedFd) -> Result<(), ContextFailure> {
        debug_assert!(self.slots[i].is_none());
        self.slots[i] = Some(fd);
        Ok(())
    }
    fn close(&mut self, i: usize) -> Result<(), ContextFailure> {
        match self.slots[i].take() {
            Some(fd) => self.closer.close(fd),
            None => Ok(()),
        }
    }
    fn close_all(&mut self) -> Result<(), ContextFailure> {
        let mut failed = false;
        for i in (0..12).rev() {
            if self.close(i).is_err() {
                failed = true;
            }
        }
        if failed {
            Err(ContextFailure::Close)
        } else {
            Ok(())
        }
    }
}
impl Drop for Fds {
    fn drop(&mut self) {
        let _ = self.close_all();
    }
}
fn finish<T>(
    result: Result<T, ContextFailure>,
    closure: Result<(), ContextFailure>,
) -> Result<T, ContextFailure> {
    closure?;
    result
}
fn owned(raw: RawFd) -> Result<OwnedFd, ContextFailure> {
    if raw < 0 {
        Err(ContextFailure::Filesystem)
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(raw) })
    }
}
fn observe(fd: RawFd) -> Result<Observation, ContextFailure> {
    let mut s = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut s) } != 0 {
        return Err(ContextFailure::Filesystem);
    }
    Ok(Observation::of(&s))
}
fn observe_checked(fd: RawFd, fault: ContextFault) -> Result<Observation, ContextFailure> {
    if fault == ContextFault::Stat {
        return Err(ContextFailure::Filesystem);
    }
    observe(fd)
}
fn open_at(parent: RawFd, name: &CStr, path_only: bool) -> Result<OwnedFd, ContextFailure> {
    let mut how: libc::open_how = unsafe { std::mem::zeroed() };
    how.flags = (libc::O_DIRECTORY
        | libc::O_CLOEXEC
        | if path_only {
            libc::O_PATH
        } else {
            libc::O_RDONLY | libc::O_NONBLOCK
        }) as u64;
    how.resolve = 0x08 | 0x04 | 0x02; // BENEATH | NO_SYMLINKS | NO_MAGICLINKS
    owned(unsafe {
        libc::syscall(
            libc::SYS_openat2,
            parent,
            name.as_ptr(),
            &how,
            std::mem::size_of::<libc::open_how>(),
        )
    } as RawFd)
}
fn rooted_walk(
    plan: &FixtureContextPlan,
    budget: &Budget<'_>,
    fds: &mut Fds,
    path_only: bool,
    stage: ContextStage,
    mut check: impl FnMut(usize, Observation) -> Result<(), ContextFailure>,
) -> Result<(), ContextFailure> {
    budget.check(stage)?;
    fds.put(
        10,
        owned(unsafe {
            libc::open(
                c"/".as_ptr(),
                libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        })?,
    )?;
    check(0, observe_checked(fds.raw(10), budget.fault)?)?;
    for (i, name) in plan.components.iter().enumerate() {
        budget.check(stage)?;
        let last = i + 1 == plan.components.len();
        fds.put(11, open_at(fds.raw(10), name, path_only || !last)?)?;
        check(i + 1, observe_checked(fds.raw(11), budget.fault)?)?;
        fds.close(10)?;
        fds.slots[10] = fds.slots[11].take();
    }
    budget.check(stage)
}

fn enumerate(
    fd: RawFd,
    root: bool,
    budget: &Budget<'_>,
    stage: ContextStage,
    closer: &mut Closer,
) -> Result<(), ContextFailure> {
    budget.check(stage)?;
    let duplicate = owned(unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 4) })?;
    let result = (|| {
        if unsafe { libc::lseek(duplicate.as_raw_fd(), 0, libc::SEEK_SET) } != 0 {
            return Err(ContextFailure::Filesystem);
        }
        let mut buffer = [0u8; 4096];
        let mut seen = 0u16;
        let mut records = 0usize;
        loop {
            budget.check(stage)?;
            let count = unsafe {
                libc::syscall(
                    libc::SYS_getdents64,
                    duplicate.as_raw_fd(),
                    buffer.as_mut_ptr(),
                    buffer.len(),
                )
            };
            if count < 0 {
                return Err(ContextFailure::Filesystem);
            }
            if count == 0 {
                break;
            }
            let mut at = 0;
            while at < count as usize {
                budget.check(stage)?;
                // Linux dirent64: ino8, offset8, reclen2, type1, name + NUL.
                if at + 20 > count as usize {
                    return Err(ContextFailure::Filesystem);
                }
                let size = u16::from_ne_bytes([buffer[at + 16], buffer[at + 17]]) as usize;
                if size < 20 || at + size > count as usize {
                    return Err(ContextFailure::Filesystem);
                }
                let bytes = &buffer[at + 19..at + size];
                let end = bytes
                    .iter()
                    .position(|b| *b == 0)
                    .ok_or(ContextFailure::Filesystem)?;
                let name = &bytes[..end];
                records += 1;
                if records > if root { 11 } else { 2 } {
                    return Err(ContextFailure::Content);
                }
                if name != b"." && name != b".." {
                    if !root {
                        return Err(ContextFailure::Content);
                    }
                    let i = LEAVES
                        .iter()
                        .position(|n| n.as_bytes() == name)
                        .ok_or(ContextFailure::Content)?;
                    if seen & (1 << i) != 0 {
                        return Err(ContextFailure::Content);
                    }
                    seen |= 1 << i;
                }
                at += size;
            }
        }
        if root && seen != 0x1ff {
            return Err(ContextFailure::Content);
        }
        budget.check(stage)
    })();
    finish(result, closer.close(duplicate))
}

fn read_bounded(
    path: &CStr,
    maximum: usize,
    budget: &Budget<'_>,
) -> Result<Vec<u8>, ContextFailure> {
    budget.check(ContextStage::BeforeCapture)?;
    let fd = owned(unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
        )
    })?;
    let mut closer = Closer {
        inject_first: false,
        attempts: 0,
    };
    let result = (|| {
        let mut bytes = vec![0u8; maximum + 1];
        let mut used = 0;
        while used < bytes.len() {
            budget.check(ContextStage::BeforeCapture)?;
            let n = unsafe {
                libc::read(
                    fd.as_raw_fd(),
                    bytes[used..].as_mut_ptr().cast(),
                    bytes.len() - used,
                )
            };
            if n < 0 {
                return Err(ContextFailure::Maps);
            }
            if n == 0 {
                break;
            }
            used += n as usize;
        }
        if used > maximum {
            return Err(ContextFailure::Maps);
        }
        bytes.truncate(used);
        Ok(bytes)
    })();
    finish(result, closer.close(fd))
}
fn identity_map(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let mut lines = text.lines();
    let Some(line) = lines.next() else {
        return false;
    };
    let fields: Vec<_> = line.split_ascii_whitespace().collect();
    fields.len() == 3
        && fields[0] == "0"
        && fields[1] == "0"
        && fields[2] == "4294967295"
        && lines.next().is_none()
}
fn overflow(bytes: &[u8]) -> Result<u32, ContextFailure> {
    let s = std::str::from_utf8(bytes)
        .map_err(|_| ContextFailure::Maps)?
        .trim();
    let n = canonical_u64(s).map_err(|_| ContextFailure::Maps)?;
    u32::try_from(n).map_err(|_| ContextFailure::Maps)
}
fn collision_free(uid: u32, gid: u32, overflow_uid: u32, overflow_gid: u32) -> bool {
    uid != overflow_uid && gid != overflow_gid
}
fn outer_identity(budget: &Budget<'_>) -> Result<(u32, u32, u32, u32), ContextFailure> {
    for path in [c"/proc/self/uid_map", c"/proc/self/gid_map"] {
        if !identity_map(&read_bounded(path, 1024, budget)?) {
            return Err(ContextFailure::Maps);
        }
    }
    let uid = unsafe { libc::getuid() };
    let gid = unsafe { libc::getgid() };
    if uid != unsafe { libc::geteuid() } || gid != unsafe { libc::getegid() } {
        return Err(ContextFailure::Maps);
    }
    let overflow_uid = overflow(&read_bounded(c"/proc/sys/kernel/overflowuid", 64, budget)?)?;
    let overflow_gid = overflow(&read_bounded(c"/proc/sys/kernel/overflowgid", 64, budget)?)?;
    if !collision_free(uid, gid, overflow_uid, overflow_gid) {
        return Err(ContextFailure::OverflowCollision);
    }
    Ok((uid, gid, overflow_uid, overflow_gid))
}

/// Actual native observations only; no directory descriptors cross the clone.
#[derive(Debug)]
struct ContextObservations {
    root: String,
    ids: [Identity; 10],
    invocation: [u8; 16],
    observations: Vec<Observation>,
    uid: u32,
    gid: u32,
    overflow_uid: u32,
    overflow_gid: u32,
}
impl ContextObservations {
    fn matches(&self, plan: &FixtureContextPlan) -> bool {
        self.root == plan.root && self.ids == plan.ids && self.invocation == plan.invocation
    }
    fn compare(&self, index: usize, actual: Observation) -> Result<(), ContextFailure> {
        let mut expected = self.observations[index];
        expected.uid = translated(expected.uid, self.uid, self.overflow_uid);
        expected.gid = translated(expected.gid, self.gid, self.overflow_gid);
        if actual == expected {
            Ok(())
        } else {
            Err(ContextFailure::Changed)
        }
    }
    pub(crate) fn acquire(
        &self,
        plan: &FixtureContextPlan,
        deadline: Instant,
        fault: ContextFault,
    ) -> Result<HeldContext, ContextFailure> {
        if !self.matches(plan) {
            return Err(ContextFailure::InvalidInput);
        }
        self.acquire_with_budget(plan, &Budget::new(None, deadline, fault, None))
    }
    fn acquire_with_budget(
        &self,
        plan: &FixtureContextPlan,
        budget: &Budget<'_>,
    ) -> Result<HeldContext, ContextFailure> {
        if !self.matches(plan) {
            return Err(ContextFailure::InvalidInput);
        }
        let fault = budget.fault;
        budget.check(ContextStage::BeforeAcquisition)?;

        let mut fds = Fds::new(fault);
        let result = (|| {
            rooted_walk(
                plan,
                &budget,
                &mut fds,
                false,
                ContextStage::AcquisitionWalk,
                |i, s| {
                    self.compare(i, s)?;
                    if i >= plan.components.len() - 1 && !private_directory(s, self.uid) {
                        return Err(ContextFailure::UnsafeDirectory);
                    }
                    Ok(())
                },
            )?;
            fds.slots[0] = fds.slots[10].take();
            enumerate(
                fds.raw(0),
                true,
                &budget,
                ContextStage::AcquisitionEnumeration,
                &mut fds.closer,
            )?;
            for (i, name) in LEAVES.iter().enumerate() {
                budget.check(ContextStage::AcquisitionWalk)?;
                fds.put(
                    i + 1,
                    open_at(fds.raw(0), &CString::new(*name).unwrap(), false)?,
                )?;
                let s = observe_checked(fds.raw(i + 1), fault)?;
                self.compare(plan.components.len() + 1 + i, s)?;
                if s.id != plan.ids[i + 1] || !private_directory(s, self.uid) {
                    return Err(ContextFailure::Changed);
                }
                enumerate(
                    fds.raw(i + 1),
                    false,
                    &budget,
                    ContextStage::AcquisitionEnumeration,
                    &mut fds.closer,
                )?;
            }
            if fault == ContextFault::Fchdir || unsafe { libc::fchdir(fds.raw(1)) } != 0 {
                return Err(ContextFailure::Filesystem);
            }
            verify_cwd(fds.raw(1))?;
            budget.check(ContextStage::AfterAcquisition)
        })();
        if let Err(error) = result {
            return finish(Err(error), fds.close_all());
        }
        Ok(HeldContext { fds })
    }
    /// Caller opens its inventory scanner first. This applies only the fixed
    /// held-object policy; every owned context FD is checked-closed on all exits.
    /// Call in the isolated target only: cwd, limits and restrictions are permanent.
    pub(crate) fn setup(
        &self,
        plan: &FixtureContextPlan,
        deadline: Instant,
        fault: ContextFault,
    ) -> Result<(), ContextFailure> {
        let held = self.acquire(plan, deadline, fault)?;
        held.restrict_revalidate_close(self, plan, &Budget::new(None, deadline, fault, None))
    }
}
pub(crate) struct HeldContext {
    fds: Fds,
}
impl HeldContext {
    fn restrict_revalidate_close(
        mut self,
        captured: &ContextObservations,
        plan: &FixtureContextPlan,
        budget: &Budget<'_>,
    ) -> Result<(), ContextFailure> {
        let fault = budget.fault;
        let mut policy = Resolved {
            paths: Vec::with_capacity(9),
            tcp_connect: vec![],
            tcp_bind: vec![],
            unix_connect: vec![],
            child_limits: Some(LIMITS),
            child_restrictions: Some(ChildRestrictions),
            cwd: PathBuf::from(format!("{}/cwd", plan.root)),
            warnings: vec![],
        };
        for (i, leaf) in LEAVES.iter().enumerate() {
            policy.paths.push(Rule {
                path: PathBuf::from(format!("{}/{leaf}", plan.root)),
                kind: if i == 8 { Kind::Read } else { Kind::Write },
                fd: self.fds.slots[i + 1].take().unwrap(),
                dir: true,
            });
        }
        let result = (|| {
            budget.check(ContextStage::BeforeLandlock)?;

            if fault == ContextFault::Rules {
                return Err(ContextFailure::Restriction);
            }
            crate::sandbox::apply(&policy).map_err(|_| ContextFailure::Restriction)?;
            budget.check(ContextStage::AfterLandlock)?;
            if fault == ContextFault::Limits {
                return Err(ContextFailure::Restriction);
            }
            crate::limits::apply(&LIMITS).map_err(|_| ContextFailure::Restriction)?;
            budget.check(ContextStage::AfterLandlock)?;
            if fault == ContextFault::Revalidate {
                return Err(ContextFailure::Changed);
            }
            captured.compare(plan.components.len(), observe(self.fds.raw(0))?)?;
            for (i, rule) in policy.paths.iter().enumerate() {
                budget.check(ContextStage::RevalidationWalk)?;
                captured.compare(plan.components.len() + 1 + i, observe(rule.fd.as_raw_fd())?)?;
            }
            let held_root = observe(self.fds.raw(0))?;
            rooted_walk(
                plan,
                &budget,
                &mut self.fds,
                true,
                ContextStage::RevalidationWalk,
                |i, s| {
                    captured.compare(i, s)?;
                    if i == plan.components.len() && s != held_root {
                        return Err(ContextFailure::Changed);
                    }
                    Ok(())
                },
            )?;
            for (i, name) in LEAVES.iter().enumerate() {
                budget.check(ContextStage::RevalidationWalk)?;
                self.fds.put(
                    11,
                    open_at(self.fds.raw(10), &CString::new(*name).unwrap(), true)?,
                )?;
                let s = observe(self.fds.raw(11))?;
                captured.compare(plan.components.len() + 1 + i, s)?;
                if s != observe(policy.paths[i].fd.as_raw_fd())? {
                    return Err(ContextFailure::Changed);
                }
                self.fds.close(11)?;
            }
            self.fds.close(10)?;
            enumerate(
                self.fds.raw(0),
                true,
                &budget,
                ContextStage::RevalidationEnumeration,
                &mut self.fds.closer,
            )?;
            for rule in &policy.paths {
                enumerate(
                    rule.fd.as_raw_fd(),
                    false,
                    &budget,
                    ContextStage::RevalidationEnumeration,
                    &mut self.fds.closer,
                )?;
            }
            verify_cwd(policy.paths[0].fd.as_raw_fd())?;
            budget.check(ContextStage::BeforeClosure)
        })();
        // Do not early-return on a close error: consume every policy leaf and root.
        if matches!(fault, ContextFault::Close | ContextFault::CloseFinal) {
            self.fds.closer.inject_first = true;
        }
        let mut closure = Ok(());
        for rule in policy.paths.drain(..) {
            if self.fds.closer.close(rule.fd).is_err() {
                closure = Err(ContextFailure::Close);
            }
        }
        if self.fds.close_all().is_err() {
            closure = Err(ContextFailure::Close);
        }
        finish(result, closure)?;
        budget.check(ContextStage::AfterClosure)
    }
}
fn verify_cwd(fd: RawFd) -> Result<(), ContextFailure> {
    let mut s = unsafe { std::mem::zeroed() };
    if unsafe { libc::stat(c".".as_ptr(), &mut s) } != 0 {
        return Err(ContextFailure::Filesystem);
    }
    if Observation::of(&s) != observe(fd)? {
        return Err(ContextFailure::Changed);
    }
    Ok(())
}

/// Constructed only after real outside capture and checked closure of all temporary FDs.
#[derive(Debug)]
pub(crate) struct CapturedContext {
    plan: FixtureContextPlan,
    observations: ContextObservations,
}
pub(crate) fn capture_context(
    plan: FixtureContextPlan,
    stop: BorrowedFd<'_>,
    deadline: Instant,
    fault: ContextFault,
) -> Result<CapturedContext, ContextFailure> {
    let observations =
        plan.capture_observations(&Budget::new(Some(stop), deadline, fault, None))?;
    Ok(CapturedContext { plan, observations })
}
pub(crate) fn capture_context_observed<'a>(
    plan: FixtureContextPlan,
    stop: BorrowedFd<'a>,
    deadline: Instant,
    fault: ContextFault,
    observer: Observer<'a>,
) -> Result<CapturedContext, ContextFailure> {
    let observations =
        plan.capture_observations(&Budget::new(Some(stop), deadline, fault, Some(observer)))?;
    Ok(CapturedContext { plan, observations })
}
impl CapturedContext {
    pub(crate) fn plan(&self) -> &FixtureContextPlan {
        &self.plan
    }
    pub(crate) fn argv(&self) -> &[CString] {
        self.plan.argv()
    }
    pub(crate) fn argv_ptrs(&self) -> &[*const libc::c_char; 26] {
        self.plan.argv_ptrs()
    }
    pub(crate) fn envp(&self) -> &[*const libc::c_char; 15] {
        self.plan.envp()
    }
    pub(crate) fn matches_invocation(&self, invocation: [u8; 16]) -> bool {
        self.plan.invocation() == invocation
    }
    pub(crate) fn acquire(
        &self,
        deadline: Instant,
        fault: ContextFault,
    ) -> Result<HeldContext, ContextFailure> {
        self.observations.acquire(&self.plan, deadline, fault)
    }
    pub(crate) fn setup(
        &self,
        deadline: Instant,
        fault: ContextFault,
    ) -> Result<(), ContextFailure> {
        self.observations.setup(&self.plan, deadline, fault)
    }
    pub(crate) fn setup_observed(
        &self,
        deadline: Instant,
        fault: ContextFault,
        observer: Observer<'_>,
    ) -> Result<(), ContextFailure> {
        let budget = Budget::new(None, deadline, fault, Some(observer));
        let held = self.observations.acquire_with_budget(&self.plan, &budget)?;
        held.restrict_revalidate_close(&self.observations, &self.plan, &budget)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::AsFd;
    use std::time::Duration;

    fn ids() -> Vec<String> {
        (0..10)
            .flat_map(|i| ["7".to_owned(), (i + 1).to_string()])
            .collect()
    }
    fn plan() -> FixtureContextPlan {
        FixtureContextPlan::parse("/fixture/parent/probe-test", &ids(), [0x2a; 16], "normal")
            .unwrap()
    }
    fn directory(uid: u32, gid: u32, permissions: u32) -> Observation {
        Observation {
            id: Identity { dev: 7, ino: 1 },
            mode: libc::S_IFDIR | permissions,
            uid,
            gid,
            ctime: 100,
            ctime_nsec: 200,
        }
    }
    #[test]
    fn exact_allocator_owner_sticky_predicates() {
        let current = 1234;
        for owner in [0, current, 4321] {
            for mode in [0o700, 0o755, 0o770, 0o777, 0o1700, 0o1777, 0o2777] {
                let s = directory(owner, 9999, mode);
                assert_eq!(
                    safe_ancestor(s, current),
                    (owner == 0 || owner == current)
                        && (mode & 0o022 == 0 || (owner == 0 && mode & 0o1000 != 0))
                );
                assert_eq!(
                    private_directory(s, current),
                    owner == current && mode == 0o700
                );
            }
        }
        let mut s = directory(current, 9999, 0o700);
        s.mode = libc::S_IFREG | 0o700;
        assert!(!safe_ancestor(s, current));
        assert!(!private_directory(s, current));
        // GID is a fingerprint, never a primary-GID gate.
        assert!(private_directory(directory(current, 0, 0o700), current));
    }
    #[test]
    fn namespace_translation_and_creator_overflow_collision() {
        for creator in [1, 1000, 4000000000] {
            for overflow in [42, 65534, 4000000001] {
                assert_eq!(translated(creator, creator, overflow), creator);
                assert_eq!(translated(0, creator, overflow), overflow);
                assert_eq!(translated(88, creator, overflow), overflow);
                assert!(collision_free(creator, creator, overflow, overflow));
                assert!(!collision_free(overflow, creator, overflow, overflow));
                assert!(!collision_free(creator, overflow, overflow, overflow));
            }
        }
        assert!(!safe_ancestor(directory(65534, 0, 0o1777), 1000));
        assert_eq!(overflow(b"12345\n"), Ok(12345));
        for bad in [b"".as_slice(), b"-1", b"4294967296", b"65534 1", b"065534"] {
            assert_eq!(overflow(bad), Err(ContextFailure::Maps));
        }
    }
    #[test]
    fn bounded_identity_maps_reject_remapping_and_single_ids() {
        assert!(identity_map(b"         0          0 4294967295\n"));
        for bad in [
            b"".as_slice(),
            b"0 0 1\n",
            b"1000 1000 1\n",
            b"0 1000 4294967295\n",
            b"0 0 4294967295\n1 1 1\n",
            b"0 0 4294967295\n\n",
            b"0 0 4294967295 extra\n",
            b"\xff",
        ] {
            assert!(!identity_map(bad));
        }
    }
    #[test]
    fn selection_requires_canonical_distinct_u64_identity_pairs() {
        for bad in [
            "",
            "+1",
            "-1",
            "01",
            " 1",
            "1 ",
            "1.0",
            "1e2",
            "18446744073709551616",
        ] {
            let mut input = ids();
            input[0] = bad.into();
            assert_eq!(
                FixtureContextPlan::parse("/fixture/parent/root", &input, [0; 16], "normal")
                    .unwrap_err(),
                ContextFailure::InvalidInput
            );
        }
        assert_eq!(canonical_u64("18446744073709551615"), Ok(u64::MAX));
        assert_eq!(canonical_u64("0"), Ok(0));
        let mut duplicate = ids();
        duplicate[3] = duplicate[1].clone();
        assert!(
            FixtureContextPlan::parse("/fixture/parent/root", &duplicate, [0; 16], "normal")
                .is_err()
        );
        for n in [0, 19, 21] {
            assert!(
                FixtureContextPlan::parse(
                    "/fixture/parent/root",
                    &vec!["1".into(); n],
                    [0; 16],
                    "normal"
                )
                .is_err()
            );
        }
    }
    #[test]
    fn exact_path_and_component_bounds() {
        for bad in [
            "",
            "/",
            "relative/root",
            "/root",
            "/parent/",
            "/parent//root",
            "/parent/./root",
            "/parent/../root",
            "/parent/root\0",
            "/parent:selection/root",
            "/parent/root\n",
            "/parent/root\u{0085}",
        ] {
            assert!(
                FixtureContextPlan::parse(bad, &ids(), [0; 16], "normal").is_err(),
                "{bad:?}"
            );
        }
        let oversized = format!("/parent/{}", "x".repeat(256));
        assert!(FixtureContextPlan::parse(&oversized, &ids(), [0; 16], "normal").is_err());
        fn length_path(n: usize) -> String {
            let mut out = String::new();
            while n - out.len() > 256 {
                out.push('/');
                out.push_str(&"x".repeat(255));
            }
            out.push('/');
            out.push_str(&"x".repeat(n - out.len()));
            out
        }
        let parent = length_path(MAX_PARENT);
        assert_eq!(parent.len(), MAX_PARENT);
        let root = format!("{parent}/{}", "r".repeat(42));
        let p = FixtureContextPlan::parse(&root, &ids(), [0; 16], "normal").unwrap();
        assert_eq!(p.root.len(), MAX_ROOT);
        assert_eq!(format!("{}/runtime", p.root).len(), MAX_LEAF);
        assert!(FixtureContextPlan::parse(&format!("{root}r"), &ids(), [0; 16], "normal").is_err());
        assert!(
            FixtureContextPlan::parse(
                &format!("{}/r", length_path(MAX_PARENT + 1)),
                &ids(),
                [0; 16],
                "normal"
            )
            .is_err()
        );
    }
    #[test]
    fn exact_environment_storage_null_termination_and_lifetime_after_move() {
        let original = plan();
        let envp = original.envp;
        let argv_ptrs = original.argv_ptrs;
        let moved = Box::new(original);
        assert_eq!(moved.env.len(), 14);
        let expected = [
            "HOME=home",
            "XDG_CONFIG_HOME=config",
            "XDG_CACHE_HOME=cache",
            "XDG_DATA_HOME=data",
            "XDG_STATE_HOME=state",
            "XDG_RUNTIME_DIR=runtime",
            "XDG_CONFIG_DIRS=empty",
            "XDG_DATA_DIRS=empty",
            "TMPDIR=tmp",
            "TMP=tmp",
            "TEMP=tmp",
            "PATH=empty",
            "LANG=C",
            "LC_ALL=C",
        ];
        for (i, field) in expected.iter().enumerate() {
            let (key, value) = field.split_once('=').unwrap();
            let full = if i < 12 {
                format!("{key}={}/{value}", moved.root)
            } else {
                field.to_string()
            };
            assert_eq!(moved.env[i].to_str().unwrap(), full);
            assert_eq!(unsafe { CStr::from_ptr(envp[i]) }, moved.env[i].as_c_str());
        }
        assert!(envp[14].is_null());
        assert!(argv_ptrs[25].is_null());
        assert_eq!(moved.argv[0].to_str().unwrap(), "sealed-context-fixture");
        assert_eq!(moved.argv[1].to_str().unwrap(), "context");
        assert_eq!(moved.argv[2].to_str().unwrap(), "2a".repeat(16));
        assert_eq!(moved.argv[3].to_str().unwrap(), moved.root);
        for i in 0..20 {
            assert_eq!(moved.argv[i + 4].to_str().unwrap(), ids()[i]);
        }
        assert_eq!(moved.argv[24].to_str().unwrap(), "normal");
        for i in 0..25 {
            assert_eq!(
                unsafe { CStr::from_ptr(argv_ptrs[i]) },
                moved.argv[i].as_c_str()
            );
        }
    }
    #[test]
    fn target_modes_are_finite() {
        for mode in [
            "normal",
            "high-exit",
            "signal",
            "cpu",
            "sandbox",
            "hold",
            "acp",
            "acp-forbidden",
            "acp-hang",
            "forge",
            "direct",
            "double",
            "detach",
            "signal-tree",
            "stdout-flood",
            "stderr-flood",
        ] {
            assert!(
                FixtureContextPlan::parse("/fixture/parent/root", &ids(), [0; 16], mode).is_ok()
            );
        }
        for mode in ["", "context", "normal\0", "custom", "../normal"] {
            assert!(
                FixtureContextPlan::parse("/fixture/parent/root", &ids(), [0; 16], mode).is_err()
            );
        }
    }
    #[test]
    fn every_fingerprint_field_and_unmapped_owner_ctime_drift_matters() {
        let initial = directory(0, 777, 0o1777);
        let captured = ContextObservations {
            root: "unused".into(),
            ids: plan().ids,
            invocation: [0; 16],
            observations: vec![initial],
            uid: 1234,
            gid: 1234,
            overflow_uid: 54321,
            overflow_gid: 12345,
        };
        let mut target = initial;
        target.uid = 54321;
        target.gid = 12345;
        assert_eq!(captured.compare(0, target), Ok(()));
        for field in 0..8 {
            let mut changed = target;
            match field {
                0 => changed.id.dev += 1,
                1 => changed.id.ino += 1,
                2 => changed.mode ^= 1,
                3 => changed.uid += 1,
                4 => changed.gid += 1,
                5 => changed.ctime += 1,
                6 => changed.ctime_nsec += 1,
                _ => {
                    changed.ctime += 1;
                    changed.uid = 54321;
                }
            }
            assert_eq!(captured.compare(0, changed), Err(ContextFailure::Changed));
        }
        let actual = directory(1234, 88, 0o700);
        let mut native: libc::stat = unsafe { std::mem::zeroed() };
        native.st_dev = actual.id.dev;
        native.st_ino = actual.id.ino;
        native.st_mode = actual.mode;
        native.st_uid = actual.uid;
        native.st_gid = actual.gid;
        native.st_ctime = actual.ctime;
        native.st_ctime_nsec = actual.ctime_nsec;
        assert_eq!(Observation::of(&native), actual);
    }
    #[test]
    fn close_failure_consumes_all_owners_without_retry() {
        let mut fds = Fds::new(ContextFault::CloseFirst);
        for i in 0..4 {
            fds.put(
                i,
                owned(unsafe {
                    libc::open(
                        c"/".as_ptr(),
                        libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
                    )
                })
                .unwrap(),
            )
            .unwrap();
        }
        assert_eq!(fds.close_all(), Err(ContextFailure::Close));
        assert_eq!(fds.closer.attempts, 4);
        assert!(fds.slots.iter().all(Option::is_none));
        assert_eq!(fds.close_all(), Ok(()));
        assert_eq!(fds.closer.attempts, 4);
        assert_eq!(
            finish::<()>(Err(ContextFailure::Content), Err(ContextFailure::Close)),
            Err(ContextFailure::Close)
        );
    }
    #[test]
    fn deadline_faults_never_renew_and_target_budget_has_no_stop() {
        let future = Instant::now() + Duration::from_secs(1);
        for (fault, stage) in [
            (ContextFault::CaptureDeadline, ContextStage::BeforeCapture),
            (
                ContextFault::AcquireDeadline,
                ContextStage::BeforeAcquisition,
            ),
            (
                ContextFault::EnumerationDeadline,
                ContextStage::AcquisitionEnumeration,
            ),
            (ContextFault::RulesDeadline, ContextStage::BeforeLandlock),
            (
                ContextFault::RevalidationDeadline,
                ContextStage::RevalidationWalk,
            ),
            (ContextFault::ClosureDeadline, ContextStage::BeforeClosure),
        ] {
            assert_eq!(
                Budget::new(None, future, fault, None).check(stage),
                Err(ContextFailure::Deadline)
            );
        }
        assert_eq!(
            Budget::new(None, Instant::now(), ContextFault::None, None)
                .check(ContextStage::BeforeCapture),
            Err(ContextFailure::Deadline)
        );
        let budget = Budget::new(None, future, ContextFault::None, None);
        assert_eq!(budget.deadline, future);
        assert!(budget.stop.is_none());
    }
    #[test]
    fn finite_observer_can_only_refuse_and_runs_once_per_stage() {
        let future = Instant::now() + Duration::from_secs(1);
        let mut count = 0;
        let mut observer = |_: ContextStage| {
            count += 1;
            Ok(())
        };
        {
            let budget = Budget::new(None, future, ContextFault::None, Some(&mut observer));
            budget.check(ContextStage::CaptureWalk).unwrap();
            budget.check(ContextStage::CaptureWalk).unwrap();
            budget.check(ContextStage::CaptureSecondPass).unwrap();
        }
        assert_eq!(count, 2);
        let mut refusal = |_: ContextStage| Err(ContextFailure::Injected);
        assert_eq!(
            Budget::new(None, future, ContextFault::None, Some(&mut refusal))
                .check(ContextStage::BeforeCapture),
            Err(ContextFailure::Injected)
        );
    }

    #[test]
    fn actual_expiry_uses_original_deadline_and_outside_stop() {
        let mut raw = [-1; 2];
        assert_eq!(
            unsafe { libc::pipe2(raw.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) },
            0
        );
        let reader = owned(raw[0]).unwrap();
        let writer = owned(raw[1]).unwrap();
        let deadline = Instant::now() + Duration::from_millis(5);
        let budget = Budget::new(
            Some(reader.as_fd()),
            deadline,
            ContextFault::Expire(ContextStage::BeforeCapture),
            None,
        );
        assert_eq!(
            budget.check(ContextStage::BeforeCapture),
            Err(ContextFailure::Deadline)
        );
        assert!(Instant::now() >= deadline);
        assert_eq!(budget.deadline, deadline);
        assert_eq!(
            unsafe { libc::write(writer.as_raw_fd(), b"s".as_ptr().cast(), 1) },
            1
        );
        let future = Instant::now() + Duration::from_secs(1);
        assert_eq!(
            Budget::new(
                Some(reader.as_fd()),
                future,
                ContextFault::Expire(ContextStage::BeforeCapture),
                None
            )
            .check(ContextStage::BeforeCapture),
            Err(ContextFailure::Stopped)
        );
        let mut closer = Closer {
            inject_first: false,
            attempts: 0,
        };
        closer.close(reader).unwrap();
        closer.close(writer).unwrap();
    }

    #[test]
    fn native_capture_isolated_retains_all_directories() {
        // An ordinary test invokes only the capture helper in a subprocess. No
        // namespaces, sandbox, providers, host configuration or cleanup occurs.
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "probe_context::tests::native_capture_child",
                "--nocapture",
            ])
            .env("GS_CONTEXT_CAPTURE_CHILD", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                return;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let observation = Instant::now() + Duration::from_secs(1);
                while Instant::now() < observation {
                    if child.try_wait().ok().flatten().is_some() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
                panic!("isolated native capture exceeded its watchdog; all fixtures retained");
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn native_capture_child() {
        if std::env::var_os("GS_CONTEXT_CAPTURE_CHILD").is_none() {
            return;
        }
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().canonicalize().unwrap();
        let parent = temp.join(format!(
            "govern-context-capture-{}-{unique}",
            std::process::id()
        ));
        let root = parent.join("probe-capture");
        let mut builder = std::fs::DirBuilder::new();
        builder.mode(0o700);
        builder.create(&parent).unwrap();
        builder.create(&root).unwrap();
        for leaf in LEAVES {
            builder.create(root.join(leaf)).unwrap();
        }
        eprintln!("retained context parent: {}", parent.display());
        eprintln!("retained context root: {}", root.display());
        for leaf in LEAVES {
            eprintln!("retained context leaf: {}", root.join(leaf).display());
        }
        let mut actual_ids = Vec::with_capacity(20);
        for path in std::iter::once(root.clone()).chain(LEAVES.map(|leaf| root.join(leaf))) {
            let meta = path.metadata().unwrap();
            actual_ids.push(meta.dev().to_string());
            actual_ids.push(meta.ino().to_string());
        }
        let plan =
            FixtureContextPlan::parse(root.to_str().unwrap(), &actual_ids, [0x35; 16], "normal")
                .unwrap();
        let mut raw = [-1; 2];
        assert_eq!(
            unsafe { libc::pipe2(raw.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) },
            0
        );
        let reader = owned(raw[0]).unwrap();
        let writer = owned(raw[1]).unwrap();
        let inventory = || {
            let mut entries = std::fs::read_dir("/proc/self/fd")
                .unwrap()
                .map(|e| {
                    e.unwrap()
                        .file_name()
                        .to_str()
                        .unwrap()
                        .parse::<i32>()
                        .unwrap()
                })
                .collect::<Vec<_>>();
            entries.sort();
            entries
        };
        let before = inventory();
        let result = capture_context(
            plan,
            reader.as_fd(),
            Instant::now() + Duration::from_secs(2),
            ContextFault::None,
        );
        assert_eq!(inventory(), before, "capture leaked an owned descriptor");
        match result {
            Ok(captured) => {
                assert!(captured.matches_invocation([0x35; 16]));
                assert!(!captured.matches_invocation([0x36; 16]));
                assert_eq!(
                    captured.observations.observations.len(),
                    captured.plan.components.len() + 10
                );
                assert!(captured.envp()[14].is_null());
                eprintln!(
                    "native capture result: accepted outside observations; target execution untested"
                );
            }
            Err(ContextFailure::Changed) => {
                eprintln!("native capture result: conservative refusal on ancestry drift")
            }
            Err(
                ContextFailure::Maps
                | ContextFailure::OverflowCollision
                | ContextFailure::UnsafeDirectory,
            ) => {
                eprintln!("native capture result: unavailable trusted outer ownership precondition")
            }
            Err(other) => panic!("native capture setup failure: {other:?}"),
        }
        let mut closer = Closer {
            inject_first: false,
            attempts: 0,
        };
        closer.close(reader).unwrap();
        closer.close(writer).unwrap();
        assert!(root.is_dir());
        assert!(LEAVES.iter().all(|leaf| root.join(leaf).is_dir()));
    }
}
