//! Protect mode: everything is allowed EXCEPT a few named paths.
//!
//! GovernCode's own tools run in the default allowlist sandbox. Protect mode exists for a
//! trusted, general-purpose agent that needs the whole machine but must not touch a handful
//! of control files (for example the pipe it receives approvals through). Landlock only
//! grants, so "all but P" is built by granting full access to every sibling along the way
//! from / down to P, and nothing to P itself. The directories on that way get read-only
//! listing: nothing new can be created directly in them (in practice: /, /run, and the
//! protected file's own directory; keep protected files in a directory of their own).
//!
//! Policy:
//! {"version": 1, "mode": "protect", "protect": ["/abs/path", ...], "cwd": "/abs/path"}
//! No network or socket rules and no seccomp beyond what Landlock implies; no_new_privs is
//! set, as the kernel requires, so setuid programs (sudo) do not elevate inside.

use landlock::{
    Access, AccessFs, CompatLevel, Compatible, PathBeneath, Ruleset, RulesetAttr,
    RulesetCreatedAttr, RulesetStatus, ABI,
};
use serde::Deserialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Raw {
    version: u32,
    mode: String,
    protect: Vec<PathBuf>,
    cwd: PathBuf,
}

pub struct Protect {
    pub protect: Vec<PathBuf>,
    pub cwd: PathBuf,
}

/// Is this policy file a protect-mode policy? (Peeks at "mode" without the strict parser.)
pub fn is_protect(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.get("mode").and_then(|m| m.as_str()).map(|m| m == "protect"))
        .unwrap_or(false)
}

pub fn parse(text: &str) -> Result<Protect, String> {
    let raw: Raw = serde_json::from_str(text).map_err(|e| format!("invalid protect policy: {e}"))?;
    if raw.version != 1 || raw.mode != "protect" {
        return Err("protect policy must have version 1 and mode \"protect\"".into());
    }
    if raw.protect.is_empty() {
        return Err("protect: nothing listed (use the default mode instead)".into());
    }
    for p in &raw.protect {
        if !p.is_absolute() || p == Path::new("/") {
            return Err(format!("protect: {} must be an absolute path below /", p.display()));
        }
        if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(format!("protect: {} must not contain ..", p.display()));
        }
        // The rules are built along this exact path; a symlink on it would protect the
        // link while its target stays reachable (security review 2026-09-27).
        for a in p.ancestors() {
            if std::fs::symlink_metadata(a).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err(format!("protect: {} passes through the symlink {}; list the real path", p.display(), a.display()));
            }
        }
    }
    if !raw.cwd.is_absolute() || !raw.cwd.is_dir() {
        return Err(format!("cwd {} must be an existing absolute directory", raw.cwd.display()));
    }
    Ok(Protect { protect: raw.protect, cwd: raw.cwd })
}

/// The rules: full access to every entry beside the way down to a protected path,
/// read-only listing on the way itself, nothing on the protected paths.
pub fn rules(p: &Protect) -> Result<(Vec<PathBuf>, Vec<PathBuf>), String> {
    let mut on_way: BTreeSet<PathBuf> = BTreeSet::new();
    for target in &p.protect {
        for a in target.ancestors().skip(1) {
            on_way.insert(a.to_path_buf());
        }
    }
    let protected: BTreeSet<PathBuf> = p.protect.iter().cloned().collect();
    let mut full = Vec::new();
    for dir in &on_way {
        let entries = std::fs::read_dir(dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let child = entry.path();
            if on_way.contains(&child) || protected.contains(&child) {
                continue;
            }
            // A sibling symlink gets no rule of its own: granting it would grant its target,
            // which may be the protected directory itself (/tmp/alias -> /tmp/control).
            // Following it still works wherever the target is granted anyway.
            if entry.file_type().is_ok_and(|t| t.is_symlink()) {
                continue;
            }
            full.push(child);
        }
    }
    Ok((full, on_way.into_iter().collect()))
}

/// O_PATH, not following a final symlink, and refusing symlinks on the way (openat2).
fn open_nofollow(path: &Path) -> std::io::Result<std::os::fd::OwnedFd> {
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))?;
    let mut how: libc::open_how = unsafe { std::mem::zeroed() };
    how.flags = (libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC) as u64;
    how.resolve = libc::RESOLVE_NO_SYMLINKS | libc::RESOLVE_NO_MAGICLINKS;
    let fd = unsafe { libc::syscall(libc::SYS_openat2, libc::AT_FDCWD, c.as_ptr(), &how as *const libc::open_how, std::mem::size_of::<libc::open_how>()) };
    if fd < 0 {
        // ELOOP: the final component is a symlink. Open the link itself so the caller sees it.
        if std::io::Error::last_os_error().raw_os_error() == Some(libc::ELOOP) {
            let fd = unsafe { libc::open(c.as_ptr(), libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
            if fd >= 0 {
                let fd = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) };
                // Only the final link itself is acceptable here; a link earlier on the way is not.
                let mut st: libc::stat = unsafe { std::mem::zeroed() };
                use std::os::fd::AsRawFd;
                if unsafe { libc::fstat(fd.as_raw_fd(), &mut st) } == 0 && st.st_mode & libc::S_IFMT == libc::S_IFLNK {
                    return Ok(fd);
                }
                return Err(std::io::Error::from_raw_os_error(libc::ELOOP));
            }
        }
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { std::os::fd::OwnedFd::from_raw_fd(fd as i32) })
}

pub fn apply(p: &Protect, abi: i32) -> Result<(), String> {
    if abi < 1 {
        return Err("cannot enforce protect mode: this kernel has no Landlock".into());
    }
    let (full, on_way) = rules(p)?;
    let err = |e: &dyn std::fmt::Display| format!("cannot enforce protect mode: {e}");
    let all = AccessFs::from_all(ABI::V6);
    let mut ruleset = Ruleset::default()
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(all)
        .map_err(|e| err(&e))?
        .create()
        .map_err(|e| err(&e))?;
    for path in &full {
        // Opened without following a final symlink: an entry that became a link after it was
        // listed is skipped here, never granted (its target may be the protected directory).
        // Entries can also vanish between listing and here (temp files): skip those, not fail.
        let Ok(fd) = open_nofollow(path) else { continue };
        let Ok(meta) = std::fs::File::from(fd.try_clone().map_err(|e| err(&e))?).metadata() else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        let access = if meta.is_dir() { all } else { all & AccessFs::from_file(ABI::V6) };
        ruleset = ruleset.add_rule(PathBeneath::new(fd, access)).map_err(|e| err(&format!("{}: {e}", path.display())))?;
    }
    for dir in &on_way {
        let fd = open_nofollow(dir).map_err(|e| err(&format!("{}: {e}", dir.display())))?;
        ruleset = ruleset
            .add_rule(PathBeneath::new(fd, AccessFs::ReadDir | AccessFs::Execute))
            .map_err(|e| err(&format!("{}: {e}", dir.display())))?;
    }
    let status = ruleset.restrict_self().map_err(|e| err(&e))?;
    if status.ruleset != RulesetStatus::FullyEnforced {
        return Err(format!("protect mode: Landlock reported {:?}, not full enforcement", status.ruleset));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_policies() {
        let bad = |t: &str| parse(t).err().unwrap_or_default();
        assert!(bad(r#"{"version":1,"mode":"protect","protect":[],"cwd":"/"}"#).contains("nothing listed"));
        assert!(bad(r#"{"version":1,"mode":"protect","protect":["relative"],"cwd":"/"}"#).contains("absolute"));
        assert!(bad(r#"{"version":1,"mode":"protect","protect":["/"],"cwd":"/"}"#).contains("below /"));
        assert!(bad(r#"{"version":1,"mode":"protect","protect":["/a/../b"],"cwd":"/"}"#).contains(".."));
        assert!(bad(r#"{"version":1,"mode":"protect","protect":["/x"],"cwd":"/","extra":1}"#).contains("invalid"));
        assert!(is_protect(r#"{"mode":"protect"}"#) && !is_protect(r#"{"version":1}"#));
    }

    #[test]
    fn child_limits_are_not_supported_in_protect_mode() {
        for limits in ["null", r#"{"cpu_seconds":1,"address_space_bytes":67108864,"open_files":32}"#] {
            let text = format!(r#"{{"version":1,"mode":"protect","protect":["/fixture"],"cwd":"/","child_limits":{limits}}}"#);
            assert!(is_protect(&text));
            assert!(parse(&text).err().unwrap().contains("unknown field `child_limits`"));
        }
    }

    #[test]
    fn child_restrictions_are_rejected_in_protect_mode() {
        for value in ["null", "false", "[]", "[true,true]", "{}", r#"{"deny_network":true,"deny_chmod":true}"#] {
            let text = format!(r#"{{"version":1,"mode":"protect","protect":["/fixture"],"cwd":"/","child_restrictions":{value}}}"#);
            assert!(is_protect(&text));
            assert!(parse(&text).err().unwrap().contains("unknown field `child_restrictions`"));
        }
    }

    #[test]
    fn grants_everything_beside_the_way_and_nothing_on_the_target() {
        let dir = std::env::temp_dir().join(format!("gs-protect-{}", std::process::id()));
        let ctl = dir.join("control");
        std::fs::create_dir_all(&ctl).unwrap();
        std::fs::write(dir.join("sibling.txt"), b"x").unwrap();
        std::fs::write(ctl.join("pipe"), b"").unwrap();
        std::fs::write(ctl.join("other"), b"").unwrap();
        let p = Protect { protect: vec![ctl.join("pipe")], cwd: dir.clone() };
        let (full, on_way) = rules(&p).unwrap();
        assert!(full.contains(&dir.join("sibling.txt")));
        assert!(full.contains(&ctl.join("other")));
        assert!(!full.contains(&ctl.join("pipe")));
        assert!(on_way.contains(&ctl) && on_way.contains(&PathBuf::from("/")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_sibling_symlink_never_grants_the_protected_directory() {
        let dir = std::env::temp_dir().join(format!("gs-protect-alias-{}", std::process::id()));
        let ctl = dir.join("control");
        std::fs::create_dir_all(&ctl).unwrap();
        std::fs::write(ctl.join("approval"), b"").unwrap();
        std::os::unix::fs::symlink(&ctl, dir.join("alias")).unwrap();
        let p = Protect { protect: vec![ctl.join("approval")], cwd: dir.clone() };
        let (full, _) = rules(&p).unwrap();
        assert!(!full.contains(&dir.join("alias")), "the alias must not be granted");
        let through = format!(r#"{{"version":1,"mode":"protect","protect":["{}"],"cwd":"/"}}"#, dir.join("alias/approval").display());
        assert!(parse(&through).err().unwrap_or_default().contains("symlink"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
