//! The policy file govd writes for each run, and its validation.
//!
//! Validation is strict on purpose: an unknown key or a malformed path means govd and
//! govern-sup disagree about what the sandbox should be, and guessing would widen it.

use serde::Deserialize;
use std::path::{Path, PathBuf};

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
    /// Pathname Unix sockets the tool may connect to (e.g. the system DNS resolver's);
    /// every other local socket stays out of reach. Enforced per path from Landlock ABI 9.
    #[serde(default)]
    pub unix_connect: Vec<PathBuf>,
    pub cwd: PathBuf,
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

/// A policy checked against the real filesystem, ready to turn into Landlock rules.
#[derive(Debug)]
pub struct Resolved {
    pub paths: Vec<(PathBuf, Kind)>,
    pub tcp_connect: Vec<u16>,
    pub unix_connect: Vec<PathBuf>,
    pub cwd: PathBuf,
    /// Non-fatal notes (skipped missing read/exec paths) for stderr.
    pub warnings: Vec<String>,
}

pub fn load(file: &Path) -> Result<Resolved, String> {
    let text = std::fs::read_to_string(file)
        .map_err(|e| format!("cannot read policy {}: {e}", file.display()))?;
    parse(&text)
}

pub fn parse(text: &str) -> Result<Resolved, String> {
    let policy: Policy = serde_json::from_str(text).map_err(|e| format!("invalid policy: {e}"))?;
    resolve(policy)
}

fn resolve(p: Policy) -> Result<Resolved, String> {
    if p.version != 1 {
        return Err(format!("unsupported policy version {} (expected 1)", p.version));
    }
    let mut out = Resolved {
        paths: Vec::new(),
        tcp_connect: p.tcp_connect,
        unix_connect: Vec::new(),
        cwd: PathBuf::new(),
        warnings: Vec::new(),
    };
    if let Some(port) = out.tcp_connect.iter().find(|&&port| port == 0) {
        return Err(format!("tcp_connect: port {port} is not a valid destination port"));
    }

    for path in p.unix_connect {
        if !path.is_absolute() {
            return Err(format!("unix_connect: {} is not an absolute path", path.display()));
        }
        if path.exists() {
            out.unix_connect.push(path);
        } else {
            out.warnings.push(format!("unix_connect: {} does not exist; skipped", path.display()));
        }
    }

    let lists = [(p.read, Kind::Read), (p.write, Kind::Write), (p.exec, Kind::Exec)];
    for (list, kind) in lists {
        for path in list {
            let key = key_name(kind);
            if !path.is_absolute() {
                return Err(format!("{key}: path {} is not absolute", path.display()));
            }
            match std::fs::symlink_metadata(&path) {
                Ok(_) => out.paths.push((path, kind)),
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
    let inside = out.paths.iter().any(|(path, kind)| {
        *kind != Kind::Exec && path.canonicalize().is_ok_and(|root| cwd.starts_with(root))
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
        assert_eq!(r.paths.len(), 1);
        assert!(r.warnings.is_empty());
    }

    #[test]
    fn full_policy_parses() {
        let t = TempDir::new("full");
        let extra = r#","read":["/usr"],"exec":["/usr/bin"],"tcp_connect":[443,80]"#;
        let r = parse(&policy(&t, extra)).unwrap();
        assert_eq!(r.tcp_connect, vec![443, 80]);
        assert!(r.paths.contains(&(PathBuf::from("/usr"), Kind::Read)));
        assert!(r.paths.contains(&(PathBuf::from("/usr/bin"), Kind::Exec)));
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
    }
}
