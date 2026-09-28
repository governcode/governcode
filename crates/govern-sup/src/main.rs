//! govern-sup: starts one AI tool inside a deny-by-default sandbox (see docs/SANDBOX.md).

mod policy;
mod protect;
mod sandbox;
mod selftest;
mod supervise;

use std::path::Path;
use std::process::ExitCode;

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

/// Runs the tool as our child, restricted, and stays outside the sandbox as its reaper: when
/// the tool exits (or govd stops us), every process it left behind is killed, so nothing
/// the tool started outlives the run (security review 2026-09-27). The tool keeps our stdio
/// pipes from govd and our environment; its exit status becomes ours.
fn run(args: &[String]) -> Result<ExitCode, String> {
    let (policy_file, argv) = match args {
        [flag, file, sep, argv @ ..] if flag == "--policy" && sep == "--" && !argv.is_empty() => (file, argv),
        _ => return Err(USAGE.to_string()),
    };
    let text = policy::read_bounded(Path::new(policy_file))?;
    if protect::is_protect(&text) {
        // Protect mode: the whole machine except the listed paths (see protect.rs).
        let p = protect::parse(&text)?;
        std::env::set_current_dir(&p.cwd).map_err(|e| format!("cwd {}: {e}", p.cwd.display()))?;
        return supervise::run(argv, || {
            sandbox::no_new_privs()?;
            protect::apply(&p, sandbox::kernel_abi())?;
            sandbox::close_inherited()
        });
    }
    let policy = policy::parse(&text)?;
    for w in &policy.warnings {
        eprintln!("govern-sup: warning: {w}");
    }
    std::env::set_current_dir(&policy.cwd).map_err(|e| format!("cwd {}: {e}", policy.cwd.display()))?;
    supervise::run(argv, || {
        sandbox::apply(&policy)?;
        sandbox::close_inherited()
    })
}
