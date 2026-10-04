//! The policy file govd writes for each run, and its validation.
//!
//! Validation is strict on purpose: an unknown key or a malformed path means govd and
//! govern-sup disagree about what the sandbox should be, and guessing would widen it.

use serde::Deserialize;
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::FileTypeExt;
use std::path::{Component, Path, PathBuf};

/// Bounds on what govd may ask for, checked before anything is allocated per entry.
const MAX_POLICY_BYTES: u64 = 1 << 20;
const MAX_ENTRIES: usize = 4096;
const MAX_PATH_BYTES: usize = 4096;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub version: u32,
    #[serde(default)]
    pub read: Vec<PathBuf>,
    #[serde(default)]
    pub write: Vec<PathBuf>,
    #[serde(default)]
    pub exec: Vec<PathBuf>,
    #[serde(default = "default_ports")]
    pub tcp_connect: Vec<u16>,
    /// Local TCP ports the tool may listen on (0: a port the kernel picks). Empty by default:
    /// no AI tool ever listens. Only a sign-in whose browser calls back to localhost gets [0].
    #[serde(default)]
    pub tcp_bind: Vec<u16>,
    /// Pathname Unix sockets the tool may connect to (e.g. the system DNS resolver's);
    /// every other local socket stays out of reach. Enforced per path from Landlock ABI 9.
    #[serde(default)]
    pub unix_connect: Vec<PathBuf>,
    /// Optional per-process ceilings, applied only to the forked child before exec.
    #[serde(default, deserialize_with = "child_limits")]
    pub child_limits: Option<ChildLimits>,
    /// Fixed opt-in syscall restrictions; only omission means absent.
    #[serde(default, deserialize_with = "child_restrictions")]
    pub child_restrictions: Option<ChildRestrictions>,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChildLimits {
    #[serde(deserialize_with = "finite_limit")]
    pub cpu_seconds: libc::rlim_t,
    #[serde(deserialize_with = "finite_limit")]
    pub address_space_bytes: libc::rlim_t,
    #[serde(deserialize_with = "finite_limit")]
    pub open_files: libc::rlim_t,
}

fn finite_limit<'de, D: serde::Deserializer<'de>>(d: D) -> Result<libc::rlim_t, D::Error> {
    // Deserialize directly into the native type: no truncating conversion or floats.
    let value = libc::rlim_t::deserialize(d)?;
    if value == 0 || value == libc::RLIM_INFINITY {
        return Err(serde::de::Error::custom("child limit must be a finite positive integer"));
    }
    Ok(value)
}

fn child_limits<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<ChildLimits>, D::Error> {
    // Only an omitted key means absent. Derived struct deserialization accepts positional
    // arrays, so require a map first and let the struct retain strict/duplicate field checks.
    struct LimitsObject;
    impl<'de> serde::de::Visitor<'de> for LimitsObject {
        type Value = Option<ChildLimits>;

        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a child_limits object with named fields")
        }

        fn visit_map<A: serde::de::MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
            ChildLimits::deserialize(serde::de::value::MapAccessDeserializer::new(map)).map(Some)
        }
    }
    d.deserialize_map(LimitsObject)
}

/// Presence means both network creation and chmod-family syscalls must be denied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChildRestrictions;

fn child_restrictions<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<ChildRestrictions>, D::Error> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Fields {
        deny_network: bool,
        deny_chmod: bool,
    }
    struct RestrictionsObject;
    impl<'de> serde::de::Visitor<'de> for RestrictionsObject {
        type Value = Option<ChildRestrictions>;

        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a child_restrictions object with deny_network and deny_chmod both true")
        }

        fn visit_map<A: serde::de::MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
            let fields = Fields::deserialize(serde::de::value::MapAccessDeserializer::new(map))?;
            if !fields.deny_network || !fields.deny_chmod {
                return Err(serde::de::Error::custom("child_restrictions requires deny_network and deny_chmod both true"));
            }
            Ok(Some(ChildRestrictions))
        }
    }
    // Derived structures alone also accept arrays; this block must be a named map.
    d.deserialize_map(RestrictionsObject)
}

fn default_ports() -> Vec<u16> {
    vec![443]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Read,
    Write,
    Exec,
}

/// One path of the policy, already opened: the rule is built on this descriptor, never on
/// the path again, so nothing can be swapped in between the check and the rule.
#[derive(Debug)]
pub struct Rule {
    pub path: PathBuf,
    pub kind: Kind,
    pub fd: OwnedFd,
    pub dir: bool,
}

/// A policy checked against the real filesystem, ready to turn into Landlock rules.
#[derive(Debug)]
pub struct Resolved {
    pub paths: Vec<Rule>,
    pub tcp_connect: Vec<u16>,
    pub tcp_bind: Vec<u16>,
    pub unix_connect: Vec<Rule>,
    pub child_limits: Option<ChildLimits>,
    pub child_restrictions: Option<ChildRestrictions>,
    pub cwd: PathBuf,
    /// Non-fatal notes (skipped missing read/exec paths) for stderr.
    pub warnings: Vec<String>,
}

/// Reads a policy file, refusing anything over 1 MiB before reading it.
pub fn read_bounded(file: &Path) -> Result<String, String> {
    use std::io::Read;
    let f = std::fs::File::open(file).map_err(|e| format!("cannot read policy {}: {e}", file.display()))?;
    let mut text = String::new();
    f.take(MAX_POLICY_BYTES + 1).read_to_string(&mut text).map_err(|e| format!("cannot read policy {}: {e}", file.display()))?;
    if text.len() as u64 > MAX_POLICY_BYTES {
        return Err(format!("policy {} is larger than {MAX_POLICY_BYTES} bytes", file.display()));
    }
    Ok(text)
}

/// Where a read or exec path really leads, following symlinks one at a time, each of which
/// must be owned by root (/bin -> usr/bin): a symlink the user owns, anywhere on the way,
/// including inside a root-owned link's target, could have been planted by an earlier run
/// (security review 2026-09-27).
fn resolve_root_links(path: &Path) -> Result<PathBuf, std::io::Error> {
    let mut todo: Vec<std::ffi::OsString> = path.components().rev()
        .filter_map(|c| match c { Component::Normal(n) => Some(n.to_os_string()), _ => None }).collect();
    let mut real = PathBuf::from("/");
    let mut links = 0;
    while let Some(name) = todo.pop() {
        if name == ".." {
            real.pop();
            continue;
        }
        let next = real.join(&name);
        // Pinned: the owner check and the target read happen on this one inode, so a link
        // swapped in between cannot supply its target (security re-review 2026-09-27).
        let (meta, target) = inspect(&next)?;
        if meta.st_mode & libc::S_IFMT != libc::S_IFLNK {
            // Walking on past something means it must be a directory, as for the kernel:
            // "/etc/passwd/.." is ENOTDIR there, never "/etc".
            if !todo.is_empty() && meta.st_mode & libc::S_IFMT != libc::S_IFDIR {
                return Err(std::io::Error::from_raw_os_error(libc::ENOTDIR));
            }
            real = next;
            continue;
        }
        links += 1;
        if meta.st_uid != 0 || links > 40 {
            return Err(std::io::Error::other(format!("{} is a symlink you own (or a loop); list its real path instead", next.display())));
        }
        let target = target.ok_or_else(|| std::io::Error::from_raw_os_error(libc::EINVAL))?;
        if target.is_absolute() {
            real = PathBuf::from("/");
        }
        todo.extend(target.components().rev().filter_map(|c| match c {
            Component::Normal(n) => Some(n.to_os_string()),
            Component::ParentDir => Some("..".into()),
            _ => None,
        }));
    }
    Ok(real)
}

/// Opens `path` itself (not following it) and reads, from that one descriptor, its type and
/// owner and, for a symlink, its target.
fn inspect(path: &Path) -> Result<(libc::stat, Option<PathBuf>), std::io::Error> {
    use std::os::unix::ffi::OsStringExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))?;
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    use std::os::fd::AsRawFd;
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd.as_raw_fd(), &mut st) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    if st.st_mode & libc::S_IFMT != libc::S_IFLNK {
        return Ok((st, None));
    }
    let mut buf = vec![0u8; libc::PATH_MAX as usize];
    let n = unsafe { libc::readlinkat(fd.as_raw_fd(), c"".as_ptr(), buf.as_mut_ptr().cast(), buf.len()) };
    if n < 0 {
        return Err(std::io::Error::last_os_error());
    }
    buf.truncate(n as usize);
    Ok((st, Some(PathBuf::from(std::ffi::OsString::from_vec(buf)))))
}

/// Opens `path` as an O_PATH descriptor, never through a symlink the user owns. Write paths
/// may not pass through any symlink at all. Read and exec paths are first resolved through
/// root-owned links only, and the result is then opened with no symlinks allowed, so a link
/// swapped in after that check makes the open fail instead of redirecting it.
fn open_path(path: &Path, kind: Kind) -> Result<(OwnedFd, std::fs::Metadata), std::io::Error> {
    let real = if kind == Kind::Write { path.to_path_buf() } else { resolve_root_links(path)? };
    let c = std::ffi::CString::new(real.as_os_str().as_bytes()).map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))?;
    let mut how: libc::open_how = unsafe { std::mem::zeroed() };
    how.flags = (libc::O_PATH | libc::O_CLOEXEC) as u64;
    how.resolve = libc::RESOLVE_NO_MAGICLINKS | libc::RESOLVE_NO_SYMLINKS;
    let fd = unsafe { libc::syscall(libc::SYS_openat2, libc::AT_FDCWD, c.as_ptr(), &how as *const libc::open_how, std::mem::size_of::<libc::open_how>()) };
    if fd < 0 {
        let e = std::io::Error::last_os_error();
        if e.raw_os_error() == Some(libc::ELOOP) {
            return Err(std::io::Error::other("it passes through a symlink (a write path must be a real path)"));
        }
        return Err(e);
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
    let meta = std::fs::File::from(fd.try_clone()?).metadata()?;
    Ok((fd, meta))
}

fn plain(path: &Path) -> bool {
    path.is_absolute() && path.as_os_str().len() <= MAX_PATH_BYTES && !path.components().any(|c| matches!(c, Component::ParentDir))
}

pub fn parse(text: &str) -> Result<Resolved, String> {
    let policy: Policy = serde_json::from_str(text).map_err(|e| format!("invalid policy: {e}"))?;
    resolve(policy)
}

fn resolve(p: Policy) -> Result<Resolved, String> {
    if p.version != 1 {
        return Err(format!("unsupported policy version {} (expected 1)", p.version));
    }
    // Validate raw grants before opening any paths: a missing Unix socket must not
    // disappear as a warning and turn a contradictory policy into an accepted one.
    if p.child_restrictions.is_some() {
        for (key, nonempty) in [
            ("tcp_connect", !p.tcp_connect.is_empty()),
            ("tcp_bind", !p.tcp_bind.is_empty()),
            ("unix_connect", !p.unix_connect.is_empty()),
        ] {
            if nonempty {
                return Err(format!("child_restrictions requires empty {key}"));
            }
        }
    }
    let mut out = Resolved {
        paths: Vec::new(),
        tcp_connect: p.tcp_connect,
        tcp_bind: p.tcp_bind,
        unix_connect: Vec::new(),
        child_limits: p.child_limits,
        child_restrictions: p.child_restrictions,
        cwd: PathBuf::new(),
        warnings: Vec::new(),
    };
    if let Some(port) = out.tcp_connect.iter().find(|&&port| port == 0) {
        return Err(format!("tcp_connect: port {port} is not a valid destination port"));
    }
    let entries = p.read.len() + p.write.len() + p.exec.len() + p.unix_connect.len() + out.tcp_connect.len() + out.tcp_bind.len();
    if entries > MAX_ENTRIES {
        return Err(format!("policy lists {entries} entries (at most {MAX_ENTRIES})"));
    }

    // Each listed socket must be a socket file itself: a folder would expose every socket
    // below it (security review 2026-09-27).
    for path in p.unix_connect {
        if !plain(&path) {
            return Err(format!("unix_connect: {} must be an absolute path without ..", path.display()));
        }
        match open_path(&path, Kind::Write) {
            Ok((fd, meta)) if meta.file_type().is_socket() => {
                out.unix_connect.push(Rule { path, kind: Kind::Read, fd, dir: false })
            }
            Ok(_) => return Err(format!("unix_connect: {} is not a socket", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                out.warnings.push(format!("unix_connect: {} does not exist; skipped", path.display()))
            }
            Err(e) => return Err(format!("unix_connect: cannot use {}: {e}", path.display())),
        }
    }

    let lists = [(p.read, Kind::Read), (p.write, Kind::Write), (p.exec, Kind::Exec)];
    for (list, kind) in lists {
        for path in list {
            let key = key_name(kind);
            if !path.is_absolute() {
                return Err(format!("{key}: path {} is not absolute", path.display()));
            }
            if !plain(&path) {
                return Err(format!("{key}: path {} must not contain .. (or be over {MAX_PATH_BYTES} bytes)", path.display()));
            }
            match open_path(&path, kind) {
                Ok((fd, meta)) => out.paths.push(Rule { path, kind, fd, dir: meta.is_dir() }),
                // A missing read/exec path only means less access, so skipping it is safe.
                // A missing write path means the tool would run without the workspace it
                // was promised, which is a govd bug worth stopping on.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && kind != Kind::Write => {
                    out.warnings.push(format!("{key}: skipping missing path {}", path.display()))
                }
                Err(e) => return Err(format!("{key}: cannot use {}: {e}", path.display())),
            }
        }
    }

    if !p.cwd.is_absolute() {
        return Err(format!("cwd: {} is not absolute", p.cwd.display()));
    }
    let cwd = p
        .cwd
        .canonicalize()
        .map_err(|e| format!("cwd: cannot use {}: {e}", p.cwd.display()))?;
    if !cwd.is_dir() {
        return Err(format!("cwd: {} is not a directory", p.cwd.display()));
    }
    // Compare canonical forms so a symlink cannot place cwd outside what the policy lists.
    let inside = out.paths.iter().any(|r| {
        r.kind != Kind::Exec && r.path.canonicalize().is_ok_and(|root| cwd.starts_with(root))
    });
    if !inside {
        return Err(format!("cwd: {} is not inside a read or write path", cwd.display()));
    }
    out.cwd = cwd;
    Ok(out)
}

fn key_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Read => "read",
        Kind::Write => "write",
        Kind::Exec => "exec",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh directory under the system temp dir; removed on drop.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("govern-sup-test-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("work")).unwrap();
            TempDir(dir)
        }
        fn p(&self, rel: &str) -> String {
            self.0.join(rel).display().to_string()
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn policy(t: &TempDir, extra: &str) -> String {
        format!(r#"{{"version":1,"write":["{w}"],"cwd":"{w}"{extra}}}"#, w = t.p("work"))
    }

    #[test]
    fn minimal_policy_defaults_to_port_443() {
        let t = TempDir::new("minimal");
        let r = parse(&policy(&t, "")).unwrap();
        assert_eq!(r.tcp_connect, vec![443]);
        assert!(r.tcp_bind.is_empty(), "no AI tool listens unless the policy says so");
        assert_eq!(r.paths.len(), 1);
        assert!(r.warnings.is_empty());
        assert_eq!(r.child_limits, None);
        assert_eq!(r.child_restrictions, None);
    }

    #[test]
    fn child_limits_are_checked_and_carried_into_resolved() {
        let t = TempDir::new("limits");
        let r = parse(&policy(&t, r#","child_limits":{"cpu_seconds":2,"address_space_bytes":67108864,"open_files":32}"#)).unwrap();
        assert_eq!(r.child_limits, Some(ChildLimits { cpu_seconds: 2, address_space_bytes: 67108864, open_files: 32 }));
    }

    #[test]
    fn child_limits_reject_malformed_or_unbounded_values() {
        let t = TempDir::new("bad-limits");
        for block in ["null", "[]", "[2,67108864,32]", "{}", r#"{"cpu_seconds":1,"address_space_bytes":1}"#,
            r#"{"cpu_seconds":1,"address_space_bytes":1,"open_files":1,"extra":1}"#] {
            rejects(&policy(&t, &format!(",\"child_limits\":{block}")), "invalid policy");
        }
        for field in ["cpu_seconds", "address_space_bytes", "open_files"] {
            let mut missing = serde_json::json!({"cpu_seconds":1,"address_space_bytes":1,"open_files":1});
            missing.as_object_mut().unwrap().remove(field);
            rejects(&policy(&t, &format!(",\"child_limits\":{missing}")), "missing field");
            for bad in ["0", "-1", "1.5", "1.0", "1e2", "null", "\"1\"", "true", "1e999", "18446744073709551616"]
                .into_iter().chain([libc::RLIM_INFINITY.to_string().as_str()]) {
                let mut block = serde_json::json!({"cpu_seconds":1,"address_space_bytes":1,"open_files":1});
                block.as_object_mut().unwrap().remove(field);
                let block = block.to_string();
                let extra = format!(",\"child_limits\":{{{},{field:?}:{bad}}}", &block[1..block.len() - 1]);
                rejects(&policy(&t, &extra), "invalid policy");
            }
        }
        // Duplicate fields are also disagreement, never last-value-wins.
        rejects(&policy(&t, r#","child_limits":{"cpu_seconds":1,"cpu_seconds":2,"address_space_bytes":1,"open_files":1}"#), "duplicate field");
    }

    #[test]
    fn restrictions_require_a_strict_true_true_map() {
        let t = TempDir::new("restrictions-shapes");
        for block in ["null", "false", "true", "1", "1.0", "\"true\"", "[]", "[true,true]", "{}",
            r#"{"deny_network":true}"#, r#"{"deny_chmod":true}"#,
            r#"{"deny_network":true,"deny_chmod":true,"extra":true}"#] {
            rejects(&policy(&t, &format!(",\"child_restrictions\":{block}")), "invalid policy");
        }
        for field in ["deny_network", "deny_chmod"] {
            let other = if field == "deny_network" { "deny_chmod" } else { "deny_network" };
            for bad in ["false", "null", "0", "1", "1.0", "\"true\"", "[]", "{}"] {
                rejects(&policy(&t, &format!(r#", "child_restrictions":{{"{field}":{bad},"{other}":true}}"#)), "invalid policy");
            }
            rejects(&policy(&t, &format!(r#", "child_restrictions":{{"{field}":true,"{field}":true,"{other}":true}}"#)), "duplicate field");
        }
        rejects(&policy(&t, r#", "child_restrictions":{"deny_network":true,"deny_chmod":true},"child_restrictions":{"deny_network":true,"deny_chmod":true}"#), "duplicate field");
    }

    #[test]
    fn restrictions_reject_raw_conflicts_before_filesystem_resolution() {
        // No such cwd/write path: each conflict must be the error before any path lookup.
        let base = r#"{"version":1,"write":["relative"],"cwd":"relative","child_restrictions":{"deny_network":true,"deny_chmod":true}"#;
        for (extra, key) in [
            ("", "tcp_connect"),
            (r#", "tcp_connect":[80]"#, "tcp_connect"),
            (r#", "tcp_connect":[0]"#, "tcp_connect"),
            (r#", "tcp_connect":[],"tcp_bind":[0]"#, "tcp_bind"),
            (r#", "tcp_connect":[],"tcp_bind":[443]"#, "tcp_bind"),
            (r#", "tcp_connect":[],"unix_connect":["/missing-restriction-fixture/socket"]"#, "unix_connect"),
            (r#", "tcp_connect":[],"unix_connect":["relative"]"#, "unix_connect"),
        ] {
            rejects(&format!("{base}{extra}}}"), &format!("child_restrictions requires empty {key}"));
        }
        let t = TempDir::new("restrictions-valid");
        let r = parse(&policy(&t, r#", "tcp_connect":[],"tcp_bind":[],"unix_connect":[],"child_restrictions":{"deny_network":true,"deny_chmod":true},"child_limits":{"cpu_seconds":2,"address_space_bytes":67108864,"open_files":32}"#)).unwrap();
        assert_eq!(r.child_restrictions, Some(ChildRestrictions));
        assert!(r.child_limits.is_some());
        assert!(r.warnings.is_empty());
    }

    #[test]
    fn a_sign_in_may_list_a_bind_port() {
        let t = TempDir::new("bind");
        let r = parse(&policy(&t, r#","tcp_bind":[0]"#)).unwrap();
        assert_eq!(r.tcp_bind, vec![0]);
    }

    #[test]
    fn full_policy_parses() {
        let t = TempDir::new("full");
        let extra = r#","read":["/usr"],"exec":["/usr/bin"],"tcp_connect":[443,80]"#;
        let r = parse(&policy(&t, extra)).unwrap();
        assert_eq!(r.tcp_connect, vec![443, 80]);
        assert!(r.paths.iter().any(|x| x.path == PathBuf::from("/usr") && x.kind == Kind::Read));
        assert!(r.paths.iter().any(|x| x.path == PathBuf::from("/usr/bin") && x.kind == Kind::Exec));
    }

    #[test]
    fn empty_port_list_means_no_network() {
        let t = TempDir::new("noports");
        assert!(parse(&policy(&t, r#","tcp_connect":[]"#)).unwrap().tcp_connect.is_empty());
    }

    #[test]
    fn missing_read_and_exec_paths_are_skipped_with_warning() {
        let t = TempDir::new("skip");
        let extra = format!(r#","read":["{0}"],"exec":["{0}"]"#, t.p("nope"));
        let r = parse(&policy(&t, &extra)).unwrap();
        assert_eq!(r.paths.len(), 1);
        assert_eq!(r.warnings.len(), 2);
    }

    fn rejects(text: &str, needle: &str) {
        let err = parse(text).unwrap_err();
        assert!(err.contains(needle), "error {err:?} does not mention {needle:?}");
    }

    #[test]
    fn fail_closed_on_bad_policies() {
        let t = TempDir::new("bad");
        let w = t.p("work");
        rejects(&policy(&t, r#","allow_everything":true"#), "unknown field");
        rejects(&format!(r#"{{"version":2,"write":["{w}"],"cwd":"{w}"}}"#), "version");
        rejects(&format!(r#"{{"write":["{w}"],"cwd":"{w}"}}"#), "version");
        rejects(&format!(r#"{{"version":1,"write":["{w}"]}}"#), "cwd");
        rejects(&policy(&t, r#","read":["usr"]"#), "not absolute");
        rejects(&format!(r#"{{"version":1,"write":["{}"],"cwd":"{w}"}}"#, t.p("gone")), "write");
        rejects(&format!(r#"{{"version":1,"write":["{w}"],"cwd":"{}"}}"#, t.p("gone")), "cwd");
        rejects(&format!(r#"{{"version":1,"read":["{w}"],"cwd":"/"}}"#), "not inside");
        rejects(&format!(r#"{{"version":1,"exec":["{w}"],"cwd":"{w}"}}"#), "not inside");
        rejects(&policy(&t, r#","tcp_connect":[0]"#), "port 0");
        rejects(&policy(&t, r#","tcp_connect":[70000]"#), "invalid policy");
        rejects("not json", "invalid policy");
        rejects(&policy(&t, &format!(r#","read":["{w}/../work"]"#)), "..");
    }

    #[test]
    fn symlinks_the_user_owns_are_refused() {
        // Security review 2026-09-27: a symlink planted where a policy path should be would
        // otherwise turn that grant into access to wherever it points.
        let t = TempDir::new("links");
        let w = t.p("work");
        std::os::unix::fs::symlink(std::env::temp_dir(), t.0.join("link")).unwrap();
        let l = t.p("link");
        rejects(&format!(r#"{{"version":1,"write":["{w}","{l}"],"cwd":"{w}"}}"#), "symlink");
        rejects(&policy(&t, &format!(r#","read":["{l}"]"#)), "symlink");
        rejects(&policy(&t, &format!(r#","read":["{l}/x"]"#)), "symlink");
        // Root-owned system links (/bin -> usr/bin on merged-/usr systems) stay usable.
        if std::fs::symlink_metadata("/bin").is_ok_and(|m| m.file_type().is_symlink()) {
            assert!(parse(&policy(&t, r#","exec":["/bin"]"#)).is_ok());
        }
    }

    #[test]
    fn resolution_never_walks_past_a_file() {
        // The kernel refuses /etc/passwd/..; so must we (it must not become /etc).
        assert!(resolve_root_links(Path::new("/etc/passwd/../hosts")).is_err());
        assert_eq!(resolve_root_links(Path::new("/usr/bin")).unwrap(), PathBuf::from("/usr/bin"));
    }

    #[test]
    fn a_unix_socket_entry_must_be_a_socket() {
        let t = TempDir::new("sock");
        let w = t.p("work");
        rejects(&policy(&t, &format!(r#","unix_connect":["{w}"]"#)), "not a socket");
        let _l = std::os::unix::net::UnixListener::bind(t.0.join("s.sock")).unwrap();
        assert_eq!(parse(&policy(&t, &format!(r#","unix_connect":["{}"]"#, t.p("s.sock")))).unwrap().unix_connect.len(), 1);
    }

    #[test]
    fn oversized_policies_are_refused() {
        let t = TempDir::new("big");
        let many: Vec<String> = (0..5000).map(|i| format!(r#""/nope/{i}""#)).collect();
        rejects(&policy(&t, &format!(r#","read":[{}]"#, many.join(","))), "entries");
        let f = t.0.join("huge.json");
        std::fs::write(&f, vec![b' '; (MAX_POLICY_BYTES + 10) as usize]).unwrap();
        assert!(read_bounded(&f).unwrap_err().contains("larger than"));
    }
}
