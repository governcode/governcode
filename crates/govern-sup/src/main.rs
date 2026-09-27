//! govern-sup: starts one AI tool inside a deny-by-default sandbox (see docs/SANDBOX.md).

mod policy;
mod sandbox;
mod selftest;

use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, ExitCode};

const USAGE: &str = "usage:
  govern-sup run --policy <file.json> -- <program> [args...]
  govern-sup selftest [--json]";

/// Exit status when govern-sup itself fails (bad policy, rule not enforceable), following
/// the env(1)/timeout(1) convention so govd can tell it apart from the tool's own status.
const EXIT_SUP_FAILED: u8 = 125;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("run") => run(&args[1..]),
        // The self-test is not built yet, so it fails: govd then refuses to start any tool.
        Some("selftest") => selftest::main(&args[1..]),
        // Hidden: the self-test re-runs this binary inside a real sandbox to do its checks.
        Some("check") => selftest::check(&args[1..]),
        _ => Err(USAGE.to_string()),
    };
    match result {
        Ok(code) => code,
        Err(msg) => {
            eprintln!("govern-sup: {msg}");
            ExitCode::from(EXIT_SUP_FAILED)
        }
    }
}

/// Restricts this process and then replaces it with the tool, so the tool keeps our pid,
/// our stdio pipes from govd and our environment, and govd sees its exit status directly.
fn run(args: &[String]) -> Result<ExitCode, String> {
    let (policy_file, argv) = match args {
        [flag, file, sep, argv @ ..] if flag == "--policy" && sep == "--" && !argv.is_empty() => (file, argv),
        _ => return Err(USAGE.to_string()),
    };
    let policy = policy::load(Path::new(policy_file))?;
    for w in &policy.warnings {
        eprintln!("govern-sup: warning: {w}");
    }
    std::env::set_current_dir(&policy.cwd).map_err(|e| format!("cwd {}: {e}", policy.cwd.display()))?;
    sandbox::apply(&policy)?;
    // exec only returns on failure. Landlock refusing a binary outside `exec` lands here.
    let err = Command::new(&argv[0]).args(&argv[1..]).exec();
    Err(format!("cannot execute {}: {err} (is it under an exec path?)", argv[0]))
}
