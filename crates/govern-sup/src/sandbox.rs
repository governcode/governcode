//! Turning a resolved policy into kernel restrictions: no_new_privs, Landlock, seccomp.
//!
//! Every step is a hard requirement. If the kernel cannot enforce a rule, `apply` returns
//! an error naming the rule and the caller exits without running the tool.

use crate::policy::{ChildRestrictions, Kind, Resolved};
use landlock::{
    ABI, Access, AccessFs, AccessNet, BitFlags, CompatLevel, Compatible, NetPort, PathBeneath,
    Ruleset, RulesetAttr, RulesetCreatedAttr, RulesetStatus, Scope,
};
use std::io::Error;
use std::os::fd::AsFd;

/// The Landlock ABI the running kernel reports (0 when Landlock is missing or disabled).
///
/// Queried directly because the `landlock` crate deliberately hides the runtime ABI, and we
/// need the number to say which rule cannot be enforced.
pub fn kernel_abi() -> i32 {
    const LANDLOCK_CREATE_RULESET_VERSION: libc::c_ulong = 1;
    let v = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<u8>(),
            0usize,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    };
    v.max(0) as i32
}

/// The rules every run needs, with the Landlock ABI that introduced each. Checked before
/// building anything so the error names the rule instead of a generic crate error.
pub fn require_abi(abi: i32) -> Result<(), String> {
    const NEEDS: [(i32, &str); 3] = [
        (1, "filesystem allowlist (read/write/exec)"),
        (4, "network rule (tcp_connect allowlist, no bind)"),
        (6, "scoping rule (signals and abstract Unix sockets)"),
    ];
    for (min, rule) in NEEDS {
        if abi < min {
            let have = if abi == 0 { "no Landlock (missing or disabled at boot)".into() } else { format!("ABI {abi}") };
            return Err(format!("cannot enforce the {rule}: it needs Landlock ABI {min}, this kernel has {have}"));
        }
    }
    Ok(())
}

/// Restricts the calling process for good. Call it just before exec: after it returns Ok,
/// this process can no longer reach anything the policy does not list.
pub fn apply(policy: &Resolved) -> Result<(), String> {
    let abi = kernel_abi();
    require_abi(abi)?;
    // Build the seccomp program first so an unsupported architecture fails before any
    // restriction is half-applied.
    let filter = seccomp_filter(abi, policy.child_restrictions)?;
    set_no_new_privs()?;
    landlock(policy, abi)?;
    install_seccomp(&filter)
}

/// Marks every descriptor above stdio close-on-exec, so the tool starts with stdin, stdout
/// and stderr only. An inherited descriptor (a file or socket opened before the sandbox)
/// would otherwise be usable whatever the policy says (security review 2026-09-27).
pub fn close_inherited() -> Result<(), String> {
    let rc = unsafe { libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, libc::CLOSE_RANGE_CLOEXEC) };
    if rc == 0 {
        return Ok(());
    }
    // Kernels before 5.11: mark each open descriptor by hand. Any failure stops the run.
    let err = |e: &dyn std::fmt::Display| format!("cannot close inherited descriptors: {e}");
    let mut fds = Vec::new();
    for entry in std::fs::read_dir("/proc/self/fd").map_err(|e| err(&e))? {
        let name = entry.map_err(|e| err(&e))?.file_name();
        let fd: i32 = name.to_str().and_then(|n| n.parse().ok()).ok_or_else(|| err(&"unreadable descriptor list"))?;
        if fd > 2 {
            fds.push(fd);
        }
    }
    for fd in fds {
        // The directory listing's own descriptor is already gone (EBADF); anything else fails.
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0
            && std::io::Error::last_os_error().raw_os_error() != Some(libc::EBADF)
        {
            return Err(err(&std::io::Error::last_os_error()));
        }
    }
    Ok(())
}

pub fn no_new_privs() -> Result<(), String> {
    set_no_new_privs()
}

fn set_no_new_privs() -> Result<(), String> {
    // Without this a setuid binary inside the sandbox could regain privilege, and the kernel
    // refuses an unprivileged seccomp filter anyway.
    let ok = unsafe {
        libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0
            && libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) == 1
    };
    if ok { Ok(()) } else { Err(format!("cannot enforce no_new_privs: {}", Error::last_os_error())) }
}

fn landlock(policy: &Resolved, abi: i32) -> Result<(), String> {
    let v6 = ABI::V6;
    let mut handled = AccessFs::from_all(v6);
    // ABI 9 lets Landlock itself refuse connecting to pathname Unix sockets. seccomp already
    // blocks new AF_UNIX sockets, so this is defence in depth, used whenever it exists.
    if abi >= 9 {
        handled |= AccessFs::ResolveUnix;
    }
    let read = AccessFs::ReadFile | AccessFs::ReadDir;
    let exec = read | AccessFs::Execute;
    // Write paths get everything except execute: a tool may build files in its worktree
    // but only run binaries the policy lists.
    // Not IoctlDev (terminal ioctls such as TIOCSTI could type into the user's terminal) and
    // not ResolveUnix (Unix sockets are reachable only where unix_connect names them).
    let write = handled & !AccessFs::Execute & !AccessFs::IoctlDev & !AccessFs::ResolveUnix;

    let fs_err = |e: &dyn std::fmt::Display| format!("cannot enforce the filesystem allowlist: {e}");
    let mut ruleset = Ruleset::default()
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(handled)
        .map_err(|e| fs_err(&e))?
        .handle_access(AccessNet::BindTcp | AccessNet::ConnectTcp)
        .map_err(|e| format!("cannot enforce the network rule: {e}"))?
        .scope(Scope::Signal | Scope::AbstractUnixSocket)
        .map_err(|e| format!("cannot enforce the scoping rule: {e}"))?
        .create()
        .map_err(|e| fs_err(&e))?;

    for rule in &policy.paths {
        let mut access: BitFlags<AccessFs> = match rule.kind {
            Kind::Read => read,
            Kind::Write => write,
            Kind::Exec => exec,
        };
        // Directory-only rights (ReadDir, Make*, Remove*) are invalid on a file rule.
        if !rule.dir {
            access &= AccessFs::from_file(ABI::V9);
        }
        // The descriptor opened when the policy was checked: the path is not looked up again.
        ruleset = ruleset
            .add_rule(PathBeneath::new(rule.fd.as_fd(), access))
            .map_err(|e| fs_err(&format!("{}: {e}", rule.path.display())))?;
    }
    // The only local sockets reachable: each listed path, and nothing else. Below ABI 9
    // seccomp refuses every new AF_UNIX socket instead, so the list cannot be honoured.
    for rule in &policy.unix_connect {
        if abi < 9 {
            eprintln!("govern-sup: unix_connect {} ignored: this kernel denies all local sockets", rule.path.display());
            continue;
        }
        ruleset = ruleset
            .add_rule(PathBeneath::new(rule.fd.as_fd(), AccessFs::ResolveUnix))
            .map_err(|e| fs_err(&format!("{}: {e}", rule.path.display())))?;
    }
    // Connect rules, and bind rules only where the policy lists a port (none by default, so
    // every bind fails; a sign-in's localhost callback gets port 0, one the kernel picks).
    for &port in &policy.tcp_connect {
        ruleset = ruleset
            .add_rule(NetPort::new(port, AccessNet::ConnectTcp))
            .map_err(|e| format!("cannot enforce the network rule (port {port}): {e}"))?;
    }
    for &port in &policy.tcp_bind {
        ruleset = ruleset
            .add_rule(NetPort::new(port, AccessNet::BindTcp))
            .map_err(|e| format!("cannot enforce the bind rule (port {port}): {e}"))?;
    }

    let status = ruleset.restrict_self().map_err(|e| fs_err(&e))?;
    if status.ruleset != RulesetStatus::FullyEnforced {
        return Err(format!("Landlock reported {:?}, not full enforcement", status.ruleset));
    }
    Ok(())
}

// --- seccomp -------------------------------------------------------------------------
//
// Hand-built BPF rather than the `seccompiler` crate: the filter is ~20 instructions, and
// seccompiler has no way to reject x86_64's x32 syscall range (nr | 0x40000000), through
// which `socket` would slip past a number-based rule on kernels built with x32 support.

#[cfg(target_arch = "x86_64")]
const AUDIT_ARCH: u32 = 62 | 0x8000_0000 | 0x4000_0000; // EM_X86_64 | 64BIT | LE
#[cfg(target_arch = "aarch64")]
const AUDIT_ARCH: u32 = 183 | 0x8000_0000 | 0x4000_0000; // EM_AARCH64 | 64BIT | LE

// Offsets into struct seccomp_data. Arguments are u64; both supported arches are
// little-endian, so the low 32 bits (all that an `int` argument uses) come first.
const NR: u32 = 0;
const ARCH: u32 = 4;
const ARG0: u32 = 16;
const ARG1: u32 = 24;

fn stmt(code: u32, k: u32) -> libc::sock_filter {
    libc::sock_filter { code: code as u16, jt: 0, jf: 0, k }
}
fn jump(code: u32, k: u32, jt: u8, jf: u8) -> libc::sock_filter {
    libc::sock_filter { code: code as u16, jt, jf, k }
}
fn load(offset: u32) -> libc::sock_filter {
    stmt(libc::BPF_LD | libc::BPF_W | libc::BPF_ABS, offset)
}
fn ret(action: u32) -> libc::sock_filter {
    stmt(libc::BPF_RET | libc::BPF_K, action)
}
fn errno(e: i32) -> u32 {
    libc::SECCOMP_RET_ERRNO | (e as u32 & libc::SECCOMP_RET_DATA)
}
/// "if nr == `nr` fall through, else skip `skip` instructions"
fn if_nr(nr: libc::c_long, skip: u8) -> libc::sock_filter {
    jump(libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K, nr as u32, 0, skip)
}

// Newer syscalls the libc crate does not name yet; the numbers are shared by every
// architecture since 5.x (asm-generic/unistd.h).
const SYS_SETXATTRAT: libc::c_long = 463;
const SYS_REMOVEXATTRAT: libc::c_long = 466;
const SYS_FILE_SETATTR: libc::c_long = 469;

#[cfg(target_arch = "x86_64")]
const LEGACY: [libc::c_long; 3] = [libc::SYS_chown, libc::SYS_lchown, libc::SYS_fchown];
#[cfg(target_arch = "aarch64")]
const LEGACY: [libc::c_long; 1] = [libc::SYS_fchown];

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
const DENIED: [libc::c_long; 27] = [
    libc::SYS_shmget, libc::SYS_shmat, libc::SYS_shmctl, libc::SYS_msgget, libc::SYS_msgsnd,
    libc::SYS_msgrcv, libc::SYS_msgctl, libc::SYS_semget, libc::SYS_semop, libc::SYS_semtimedop,
    libc::SYS_semctl, libc::SYS_mq_open, libc::SYS_mq_timedsend, libc::SYS_mq_timedreceive,
    libc::SYS_mq_notify, libc::SYS_mq_getsetattr, libc::SYS_mq_unlink,
    libc::SYS_fchownat, libc::SYS_setxattr, libc::SYS_lsetxattr, libc::SYS_fsetxattr,
    libc::SYS_removexattr, libc::SYS_lremovexattr, libc::SYS_fremovexattr, SYS_SETXATTRAT,
    SYS_REMOVEXATTRAT, SYS_FILE_SETATTR,
];

// fchmodat2 is 452 in both supported native tables. Locked libc exposes it only
// on x86_64. file_setattr above carries filesystem attributes, not a POSIX mode.
const SYS_FCHMODAT2: libc::c_long = 452;

// Native constants where libc supplies them; numeric tables also permit tests of
// the other architecture without pretending to execute on that architecture.
#[cfg(target_arch = "x86_64")]
const CHMOD_X86_64: &[libc::c_long] = &[libc::SYS_chmod, libc::SYS_fchmod, libc::SYS_fchmodat, SYS_FCHMODAT2];
#[cfg(not(target_arch = "x86_64"))]
const CHMOD_X86_64: &[libc::c_long] = &[90, 91, 268, SYS_FCHMODAT2];
#[cfg(target_arch = "aarch64")]
const CHMOD_AARCH64: &[libc::c_long] = &[libc::SYS_fchmod, libc::SYS_fchmodat, SYS_FCHMODAT2];
#[cfg(not(target_arch = "aarch64"))]
const CHMOD_AARCH64: &[libc::c_long] = &[52, 53, SYS_FCHMODAT2];

fn restriction_chmod_syscalls(arch: &str, os: &str, little_endian: bool, pointer_bits: u32) -> Result<&'static [libc::c_long], String> {
    if os == "linux" && little_endian && pointer_bits == 64 {
        match arch {
            "x86_64" => return Ok(CHMOD_X86_64),
            // No native chmod syscall on aarch64; 90 is capget, not chmod.
            "aarch64" => return Ok(CHMOD_AARCH64),
            _ => {},
        }
    }
    Err("cannot enforce child_restrictions: requires native little-endian Linux LP64 x86_64 or aarch64".into())
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
pub fn seccomp_filter(abi: i32, restrictions: Option<ChildRestrictions>) -> Result<Vec<libc::sock_filter>, String> {
    let chmod = if restrictions.is_some() {
        restriction_chmod_syscalls(std::env::consts::ARCH, std::env::consts::OS, cfg!(target_endian = "little"), usize::BITS)?
    } else { &[] };
    let mut f = vec![
        // A syscall made through another ABI (e.g. int 0x80 on x86_64) would bypass every
        // number below, so any foreign-arch syscall kills the process.
        load(ARCH),
        jump(libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K, AUDIT_ARCH, 1, 0),
        ret(libc::SECCOMP_RET_KILL_PROCESS),
        load(NR),
    ];
    #[cfg(target_arch = "x86_64")]
    f.extend([
        jump(libc::BPF_JMP | libc::BPF_JGE | libc::BPF_K, 0x4000_0000, 0, 1),
        ret(errno(libc::ENOSYS)),
    ]);
    // Reaching other processes' memory or descriptors (invariant 6). io_uring is refused
    // because IORING_OP_SOCKET creates sockets without the socket syscall, bypassing the
    // AF_UNIX rule below.
    for nr in [
        libc::SYS_ptrace,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_pidfd_getfd,
        libc::SYS_io_uring_setup,
    ] {
        f.extend([if_nr(nr, 1), ret(errno(libc::EPERM))]);
    }
    // Local IPC that no path rule covers (security review 2026-09-27): System V shared
    // memory, message queues and semaphores, and POSIX message queues, would let the tool
    // read or change another same-user program's state. Ownership and extended attributes
    // are metadata Landlock does not mediate, so they are refused outright. Default
    // policies still permit chmod (npm and git need it), a documented limit.
    for nr in DENIED.into_iter().chain(LEGACY) {
        f.extend([if_nr(nr, 1), ret(errno(libc::EPERM))]);
    }
    if restrictions.is_some() {
        // A syscall primitive: existing stdio/external handles and generic I/O are
        // not validated here. All socketpairs are denied; pipe/pipe2 stay available.
        for nr in [libc::SYS_socket, libc::SYS_socketpair, libc::SYS_io_uring_enter, libc::SYS_io_uring_register]
            .into_iter().chain(chmod.iter().copied()) {
            f.extend([if_nr(nr, 1), ret(errno(libc::EPERM))]);
        }
    }
    // Terminal ioctls that type into, or drive, the terminal a descriptor points at
    // (TIOCSTI, TIOCLINUX). The kernel reads the command as a 32-bit int, so the low word
    // is the whole command.
    f.extend([
        if_nr(libc::SYS_ioctl, 5),
        load(ARG1),
        jump(libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K, libc::TIOCSTI as u32, 2, 0),
        jump(libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K, libc::TIOCLINUX as u32, 1, 0),
        ret(libc::SECCOMP_RET_ALLOW),
        ret(errno(libc::EPERM)),
    ]);
    // From ABI 9 Landlock decides which pathname Unix sockets may be reached (only the
    // policy's unix_connect list) and scoping already blocks abstract ones, so seccomp
    // leaves AF_UNIX alone; the system DNS resolver, for one, is a Unix socket.
    if abi >= 9 {
        f.push(ret(libc::SECCOMP_RET_ALLOW));
        return Ok(f);
    }
    f.extend([
        // socket(AF_UNIX, ...): the daemon, session bus and keyring are all Unix sockets.
        if_nr(libc::SYS_socket, 4),
        load(ARG0),
        jump(libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K, libc::AF_UNIX as u32, 0, 1),
        ret(errno(libc::EACCES)),
        ret(libc::SECCOMP_RET_ALLOW),
        // socketpair(.., SOCK_DGRAM, ..): an unconnected-capable datagram socket could
        // sendto() any pathname datagram socket (e.g. /dev/log) on kernels without Landlock
        // ABI 9. Stream and seqpacket pairs ignore destination addresses, so they stay.
        if_nr(libc::SYS_socketpair, 5),
        load(ARG1),
        stmt(libc::BPF_ALU | libc::BPF_AND | libc::BPF_K, 0xf), // SOCK_TYPE_MASK
        jump(libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K, libc::SOCK_DGRAM as u32, 0, 1),
        ret(errno(libc::EACCES)),
        ret(libc::SECCOMP_RET_ALLOW),
    ]);
    f.push(ret(libc::SECCOMP_RET_ALLOW));
    Ok(f)
}

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
pub fn seccomp_filter(_abi: i32, _restrictions: Option<ChildRestrictions>) -> Result<Vec<libc::sock_filter>, String> {
    Err("cannot enforce the seccomp rules: they are defined only for x86_64 and aarch64".into())
}

fn install_seccomp(filter: &[libc::sock_filter]) -> Result<(), String> {
    let prog = libc::sock_fprog { len: filter.len() as u16, filter: filter.as_ptr() as *mut _ };
    let rc = unsafe { libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &prog as *const _) };
    if rc == 0 { Ok(()) } else { Err(format!("cannot enforce the seccomp rules: {}", Error::last_os_error())) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_requirements_fail_closed_naming_the_rule() {
        assert!(require_abi(0).unwrap_err().contains("filesystem allowlist"));
        assert!(require_abi(0).unwrap_err().contains("no Landlock"));
        assert!(require_abi(3).unwrap_err().contains("network rule"));
        assert!(require_abi(5).unwrap_err().contains("scoping rule"));
        assert!(require_abi(6).is_ok());
        assert!(require_abi(10).is_ok());
    }

    #[test]
    fn seccomp_filter_is_well_formed() {
        let f = seccomp_filter(6, None).unwrap();
        // Every path must end in a return, and every jump must land inside the program.
        assert_eq!(f.last().unwrap().code as u32, libc::BPF_RET | libc::BPF_K);
        for (i, ins) in f.iter().enumerate() {
            if ins.code as u32 & 0x07 == libc::BPF_JMP {
                assert!(i + 1 + (ins.jt.max(ins.jf) as usize) < f.len(), "jump at {i} leaves the program");
            }
        }
        assert!(f.len() < 128);
    }
    // Interpret the actual generated classic BPF program, including branch offsets.
    fn decision(f: &[libc::sock_filter], nr: u32, arch: u32, arg0: u32, arg1: u32) -> u32 {
        let mut pc = 0;
        let mut a = 0;
        for _ in 0..f.len() {
            let ins = &f[pc];
            let code = ins.code as u32;
            if code == libc::BPF_LD | libc::BPF_W | libc::BPF_ABS {
                a = match ins.k { NR => nr, ARCH => arch, ARG0 => arg0, ARG1 => arg1, _ => panic!("bad load") };
            } else if code == libc::BPF_RET | libc::BPF_K {
                return ins.k;
            } else if code == libc::BPF_ALU | libc::BPF_AND | libc::BPF_K {
                a &= ins.k;
            } else {
                let yes = if code == libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K { a == ins.k }
                    else if code == libc::BPF_JMP | libc::BPF_JGE | libc::BPF_K { a >= ins.k }
                    else { panic!("unknown BPF instruction") };
                pc += if yes { ins.jt } else { ins.jf } as usize;
            }
            pc += 1;
            assert!(pc < f.len(), "BPF jump left filter");
        }
        panic!("BPF did not return")
    }

    #[test]
    fn opt_in_target_validation_and_chmod_tables_are_architecture_correct() {
        assert_eq!(restriction_chmod_syscalls("x86_64", "linux", true, 64).unwrap(), [90, 91, 268, 452]);
        assert_eq!(restriction_chmod_syscalls("aarch64", "linux", true, 64).unwrap(), [52, 53, 452]);
        for arch in ["x86_64", "aarch64", "x86", "arm", "riscv64", "unknown"] {
            for os in ["linux", "other"] {
                for little in [true, false] {
                    for bits in [16, 32, 64, 128] {
                        let supported = matches!(arch, "x86_64" | "aarch64") && os == "linux" && little && bits == 64;
                        assert_eq!(restriction_chmod_syscalls(arch, os, little, bits).is_ok(), supported);
                    }
                }
            }
        }
        // Simulated architecture table decisions, not a live aarch64 kernel check.
        for (arch, denied, allowed) in [("x86_64", vec![90, 91, 268, 452], 52), ("aarch64", vec![52, 53, 452], 90)] {
            let mut f = vec![load(NR)];
            for &nr in restriction_chmod_syscalls(arch, "linux", true, 64).unwrap() {
                f.extend([if_nr(nr, 1), ret(errno(libc::EPERM))]);
            }
            f.push(ret(libc::SECCOMP_RET_ALLOW));
            for nr in denied { assert_eq!(decision(&f, nr, 0, 0, 0), errno(libc::EPERM)); }
            assert_eq!(decision(&f, allowed, 0, 0, 0), libc::SECCOMP_RET_ALLOW);
        }
    }

    #[test]
    fn actual_filters_preserve_default_decisions_and_enforce_opt_in_at_each_abi() {
        for abi in [6, 8, 9, 10] {
            let absent = seccomp_filter(abi, None).unwrap();
            let present = seccomp_filter(abi, Some(ChildRestrictions)).unwrap();
            // Removing exactly the inserted denials must recover every default BPF
            // instruction byte, including the old ABI branch and ioctl jump offsets.
            let insertion = absent.iter().position(|ins| ins.k == libc::SYS_ioctl as u32
                && ins.code as u32 == libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K).unwrap();
            let added = 2 * (4 + restriction_chmod_syscalls(std::env::consts::ARCH, "linux", true, 64).unwrap().len());
            let words = |ins: &libc::sock_filter| (ins.code, ins.jt, ins.jf, ins.k);
            assert_eq!(absent.iter().map(words).collect::<Vec<_>>(), present[..insertion].iter()
                .chain(present[insertion + added..].iter()).map(words).collect::<Vec<_>>());
            for f in [&absent, &present] {
                for (i, ins) in f.iter().enumerate() {
                    if ins.code as u32 & 7 == libc::BPF_JMP {
                        assert!(i + 1 + (ins.jt.max(ins.jf) as usize) < f.len());
                    }
                }
                assert!(f.len() < 256);
                assert_eq!(decision(f, libc::SYS_read as u32, AUDIT_ARCH ^ 1, 0, 0), libc::SECCOMP_RET_KILL_PROCESS);
                #[cfg(target_arch = "x86_64")]
                for nr in [0x4000_0000, 0x4000_0000 | libc::SYS_socket as u32, u32::MAX] {
                    assert_eq!(decision(f, nr, AUDIT_ARCH, 0, 0), errno(libc::ENOSYS));
                }
                for nr in DENIED.into_iter().chain(LEGACY).chain([
                    libc::SYS_ptrace, libc::SYS_process_vm_readv, libc::SYS_process_vm_writev,
                    libc::SYS_pidfd_getfd, libc::SYS_io_uring_setup,
                ]) {
                    assert_eq!(decision(f, nr as u32, AUDIT_ARCH, 0, 0), errno(libc::EPERM));
                }
                for nr in [libc::SYS_read, libc::SYS_write, libc::SYS_pipe2, libc::SYS_connect,
                    libc::SYS_accept, libc::SYS_sendto, libc::SYS_recvmsg, libc::SYS_dup, libc::SYS_umask, libc::SYS_unlinkat] {
                    assert_eq!(decision(f, nr as u32, AUDIT_ARCH, 0, 0), libc::SECCOMP_RET_ALLOW);
                }
                for command in [libc::TIOCSTI as u32, libc::TIOCLINUX as u32] {
                    assert_eq!(decision(f, libc::SYS_ioctl as u32, AUDIT_ARCH, 0, command), errno(libc::EPERM));
                }
                assert_eq!(decision(f, libc::SYS_ioctl as u32, AUDIT_ARCH, 0, 0), libc::SECCOMP_RET_ALLOW);
            }
            for nr in [libc::SYS_io_uring_enter, libc::SYS_io_uring_register].into_iter().chain(
                restriction_chmod_syscalls(std::env::consts::ARCH, "linux", true, 64).unwrap().iter().copied()) {
                assert_eq!(decision(&absent, nr as u32, AUDIT_ARCH, 0, 0), libc::SECCOMP_RET_ALLOW);
                assert_eq!(decision(&present, nr as u32, AUDIT_ARCH, 0, 0), errno(libc::EPERM));
            }
            for family in [libc::AF_UNIX, libc::AF_INET, libc::AF_INET6, libc::AF_NETLINK, -1] {
                for kind in [libc::SOCK_STREAM, libc::SOCK_DGRAM, libc::SOCK_SEQPACKET, -1] {
                    for flags in [0, libc::SOCK_CLOEXEC, libc::SOCK_NONBLOCK, libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK] {
                        let typ = (kind | flags) as u32;
                        assert_eq!(decision(&present, libc::SYS_socket as u32, AUDIT_ARCH, family as u32, typ), errno(libc::EPERM));
                        assert_eq!(decision(&present, libc::SYS_socketpair as u32, AUDIT_ARCH, family as u32, typ), errno(libc::EPERM));
                        assert_eq!(decision(&absent, libc::SYS_socket as u32, AUDIT_ARCH, family as u32, typ),
                            if abi < 9 && family == libc::AF_UNIX { errno(libc::EACCES) } else { libc::SECCOMP_RET_ALLOW });
                        assert_eq!(decision(&absent, libc::SYS_socketpair as u32, AUDIT_ARCH, family as u32, typ),
                            if abi < 9 && (kind & 0xf) == libc::SOCK_DGRAM { errno(libc::EACCES) } else { libc::SECCOMP_RET_ALLOW });
                    }
                }
            }
        }
    }
}
