use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=tests/fixtures/probe_clone.c");
    if env::var_os("CARGO_FEATURE_PROBE_LIFETIME_FIXTURES").is_none() {
        return;
    }
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let object = out.join("probe_clone.o");
    assert!(
        Command::new("/usr/bin/cc")
            .args([
                "-std=c11",
                "-D_GNU_SOURCE",
                "-O2",
                "-Wall",
                "-Wextra",
                "-Werror",
                "-c"
            ])
            .arg("tests/fixtures/probe_clone.c")
            .arg("-o")
            .arg(&object)
            .status()
            .unwrap()
            .success()
    );
    assert!(
        Command::new("/usr/bin/ar")
            .arg("crs")
            .arg(out.join("libprobe_clone.a"))
            .arg(object)
            .status()
            .unwrap()
            .success()
    );
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=probe_clone");
}
