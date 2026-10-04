use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

// The installed toolchain is a trusted fixture input. Never inherit compiler
// wrappers, flags, credentials, or configuration from the invoking environment.
fn bounded(mut command: Command) -> bool {
    let Ok(mut child) = command
        .env_clear()
        .env("PATH", "/usr/bin")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                // No unbounded reap after the compiler watchdog.
                let reap_deadline = Instant::now() + Duration::from_secs(1);
                while Instant::now() < reap_deadline {
                    match child.try_wait() {
                        Ok(Some(_)) | Err(_) => break,
                        Ok(None) => thread::sleep(Duration::from_millis(10)),
                    }
                }
                return false;
            }
        }
    }
}

fn compiler(source: &str, output: &Path) -> Command {
    let mut command = Command::new("/usr/bin/cc");
    command.args([
        "-std=c11",
        "-D_GNU_SOURCE",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
    ]);
    command.arg(source).arg("-o").arg(output);
    command
}

fn main() {
    println!("cargo:rustc-check-cfg=cfg(probe_clone_unavailable)");
    println!("cargo:rerun-if-changed=tests/fixtures/probe_clone.c");
    if env::var_os("CARGO_FEATURE_PROBE_LIFETIME_FIXTURES").is_none() {
        return;
    }
    println!("cargo:rerun-if-changed=tests/fixtures/probe_lifetime.c");
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo supplies OUT_DIR"));
    let native_linux = env::var("HOST").ok() == env::var("TARGET").ok()
        && env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux");
    // The legacy lifetime module supports both native Linux architectures.
    // Its clone shim does not depend on the bound image's narrower ELF layout.
    let native_clone = native_linux
        && matches!(
            env::var("CARGO_CFG_TARGET_ARCH").as_deref(),
            Ok("x86_64" | "aarch64")
        );
    let native_bound = native_linux
        && env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("x86_64")
        && env::var("CARGO_CFG_TARGET_ENDIAN").as_deref() == Ok("little");
    let object = out.join("probe_clone.o");
    let mut cc = compiler("tests/fixtures/probe_clone.c", &object);
    cc.arg("-c");
    let mut ar = Command::new("/usr/bin/ar");
    ar.arg("crs").arg(out.join("libprobe_clone.a")).arg(&object);
    if native_clone && bounded(cc) && bounded(ar) {
        println!("cargo:rustc-link-search=native={}", out.display());
        println!("cargo:rustc-link-lib=static=probe_clone");
    } else {
        println!("cargo:rustc-cfg=probe_clone_unavailable");
        println!("cargo:warning=native lifetime fixture compiler/platform unavailable");
    }

    let mut available = native_bound;
    for (name, variant) in [("probe_fixture_a", "1"), ("probe_fixture_b", "2")] {
        let image = out.join(name);
        // Always replace stale assets, including a prior successful feature build.
        fs::write(&image, []).expect("write fixture asset placeholder");
        let mut cc = compiler("tests/fixtures/probe_lifetime.c", &image);
        cc.args([
            "-static",
            "-fno-pie",
            "-no-pie",
            "-Wl,-z,max-page-size=4096",
            "-Wl,--discard-sframe",
        ])
        .arg(format!("-DPROBE_FIXTURE_IMAGE={variant}"));
        if !native_bound || !bounded(cc) {
            available = false;
        }
        let valid_size =
            fs::metadata(&image).is_ok_and(|m| (64..=4 * 1024 * 1024).contains(&m.len()));
        available &= valid_size;
    }
    if !available {
        for name in ["probe_fixture_a", "probe_fixture_b"] {
            fs::write(out.join(name), []).expect("clear unavailable fixture asset");
        }
        println!("cargo:warning=static native artifact fixture unavailable");
    }
    println!(
        "cargo:rustc-env=PROBE_FIXTURE_BUILD_AVAILABLE={}",
        if available { "1" } else { "0" }
    );
}
