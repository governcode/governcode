//! Opt-in ceilings for the forked child. CPU time and virtual address space are per
//! process, not totals for the run; these limits do not replace descendant collection.

use crate::policy::ChildLimits;
use std::io;

/// Called only in the child's restriction closure, after sandbox setup and before exec.
pub fn apply(limits: &ChildLimits) -> Result<(), String> {
    apply_with(limits, &mut Kernel)
}

// Keep the seam at the two syscalls, so tests exercise the actual clamp/readback logic.
trait Syscalls {
    fn get(&mut self, resource: libc::__rlimit_resource_t) -> io::Result<libc::rlimit>;
    fn set(&mut self, resource: libc::__rlimit_resource_t, value: &libc::rlimit) -> io::Result<()>;
}

struct Kernel;
impl Syscalls for Kernel {
    fn get(&mut self, resource: libc::__rlimit_resource_t) -> io::Result<libc::rlimit> {
        let mut value = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if unsafe { libc::getrlimit(resource, &mut value) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(value)
    }

    fn set(&mut self, resource: libc::__rlimit_resource_t, value: &libc::rlimit) -> io::Result<()> {
        if unsafe { libc::setrlimit(resource, value) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

fn apply_with(limits: &ChildLimits, sys: &mut impl Syscalls) -> Result<(), String> {
    for (resource, name, ceiling) in [
        (libc::RLIMIT_CPU, "RLIMIT_CPU", limits.cpu_seconds),
        (libc::RLIMIT_AS, "RLIMIT_AS", limits.address_space_bytes),
        (libc::RLIMIT_NOFILE, "RLIMIT_NOFILE", limits.open_files),
    ] {
        let inherited = sys
            .get(resource)
            .map_err(|e| format!("child limits: getrlimit {name}: {e}"))?;
        let expected = libc::rlimit {
            rlim_cur: inherited.rlim_cur.min(ceiling),
            rlim_max: inherited.rlim_max.min(ceiling),
        };
        sys.set(resource, &expected)
            .map_err(|e| format!("child limits: setrlimit {name}: {e}"))?;
        let effective = sys
            .get(resource)
            .map_err(|e| format!("child limits: readback {name}: {e}"))?;
        if effective.rlim_cur != expected.rlim_cur || effective.rlim_max != expected.rlim_max {
            return Err(format!(
                "child limits: {name} readback mismatch (expected soft/hard {}/{}, got {}/{})",
                expected.rlim_cur, expected.rlim_max, effective.rlim_cur, effective.rlim_max
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const LIMITS: ChildLimits = ChildLimits {
        cpu_seconds: 2,
        address_space_bytes: 67108864,
        open_files: 32,
    };

    struct Fake {
        calls: usize,
        fail: Option<usize>,
        mismatch: Option<(usize, bool)>,
        current: [libc::rlimit; 3],
        writes: Vec<(libc::__rlimit_resource_t, libc::rlim_t, libc::rlim_t)>,
    }
    impl Fake {
        fn new(soft: libc::rlim_t, hard: libc::rlim_t) -> Self {
            Self {
                calls: 0,
                fail: None,
                mismatch: None,
                current: std::array::from_fn(|_| libc::rlimit {
                    rlim_cur: soft,
                    rlim_max: hard,
                }),
                writes: Vec::new(),
            }
        }
        fn step(&mut self, resource: libc::__rlimit_resource_t) -> io::Result<usize> {
            let index = self.calls / 3;
            assert_eq!(
                resource,
                [libc::RLIMIT_CPU, libc::RLIMIT_AS, libc::RLIMIT_NOFILE][index]
            );
            self.calls += 1;
            if self.fail == Some(self.calls) {
                Err(io::Error::from_raw_os_error(libc::EPERM))
            } else {
                Ok(index)
            }
        }
    }
    impl Syscalls for Fake {
        fn get(&mut self, resource: libc::__rlimit_resource_t) -> io::Result<libc::rlimit> {
            let index = self.step(resource)?;
            let mut value = libc::rlimit {
                rlim_cur: self.current[index].rlim_cur,
                rlim_max: self.current[index].rlim_max,
            };
            if let Some((call, soft)) = self.mismatch
                && self.calls == call
            {
                if soft {
                    value.rlim_cur += 1;
                } else {
                    value.rlim_max += 1;
                }
            }
            Ok(value)
        }
        fn set(
            &mut self,
            resource: libc::__rlimit_resource_t,
            value: &libc::rlimit,
        ) -> io::Result<()> {
            let index = self.step(resource)?;
            self.writes.push((resource, value.rlim_cur, value.rlim_max));
            self.current[index] = libc::rlimit {
                rlim_cur: value.rlim_cur,
                rlim_max: value.rlim_max,
            };
            Ok(())
        }
    }

    #[test]
    fn clamps_both_values_without_raising_either() {
        for (soft, hard) in [
            (libc::RLIM_INFINITY, libc::RLIM_INFINITY),
            (1, 1),
            (1, 10),
            (0, 0),
        ] {
            let mut sys = Fake::new(soft, hard);
            apply_with(&LIMITS, &mut sys).unwrap();
            assert_eq!(
                sys.writes,
                vec![
                    (
                        libc::RLIMIT_CPU,
                        soft.min(LIMITS.cpu_seconds),
                        hard.min(LIMITS.cpu_seconds)
                    ),
                    (
                        libc::RLIMIT_AS,
                        soft.min(LIMITS.address_space_bytes),
                        hard.min(LIMITS.address_space_bytes)
                    ),
                    (
                        libc::RLIMIT_NOFILE,
                        soft.min(LIMITS.open_files),
                        hard.min(LIMITS.open_files)
                    ),
                ]
            );
            assert_eq!(sys.calls, 9);
        }
    }

    #[test]
    fn every_syscall_failure_and_readback_mismatch_stops_application() {
        for call in 1..=9 {
            let mut sys = Fake::new(libc::RLIM_INFINITY, libc::RLIM_INFINITY);
            sys.fail = Some(call);
            let error = apply_with(&LIMITS, &mut sys).unwrap_err();
            assert!(error.contains(match call % 3 {
                1 => "getrlimit",
                2 => "setrlimit",
                _ => "readback",
            }));
            assert_eq!(sys.calls, call, "must not continue after failure");
        }
        for call in [3, 6, 9] {
            for soft in [false, true] {
                let mut sys = Fake::new(libc::RLIM_INFINITY, libc::RLIM_INFINITY);
                sys.mismatch = Some((call, soft));
                assert!(
                    apply_with(&LIMITS, &mut sys)
                        .unwrap_err()
                        .contains("readback mismatch")
                );
                assert_eq!(sys.calls, call);
            }
        }
    }

    #[test]
    fn injected_failures_prevent_target_exec() {
        // The supervisor changes signals/subreaper state, so exercise it in an isolated
        // test subprocess. The fake never changes real resource limits.
        let marker = std::env::temp_dir().join(format!("gs-limits-no-exec-{}", std::process::id()));
        assert!(!marker.exists());
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "limits::tests::failure_child", "--nocapture"])
            .env("GS_LIMITS_FAILURE_MARKER", &marker)
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("failure injection subprocess exceeded watchdog");
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(status.success());
        assert!(
            !marker.exists(),
            "target executed after a restriction failure"
        );
    }

    #[test]
    fn failure_child() {
        let Some(marker) = std::env::var_os("GS_LIMITS_FAILURE_MARKER") else {
            return;
        };
        let argv = vec!["/usr/bin/touch".into(), marker.to_str().unwrap().into()];
        // Control: the same native marker target must execute when verification succeeds.
        let status = crate::supervise::run(&argv, || {
            apply_with(
                &LIMITS,
                &mut Fake::new(libc::RLIM_INFINITY, libc::RLIM_INFINITY),
            )
        })
        .unwrap();
        assert_eq!(status, std::process::ExitCode::SUCCESS);
        assert!(std::path::Path::new(&marker).exists());
        std::fs::remove_file(&marker).unwrap();
        for call in 1..=9 {
            let status = crate::supervise::run(&argv, || {
                let mut sys = Fake::new(libc::RLIM_INFINITY, libc::RLIM_INFINITY);
                sys.fail = Some(call);
                apply_with(&LIMITS, &mut sys)
            })
            .unwrap();
            assert_eq!(status, std::process::ExitCode::from(125));
            assert!(!std::path::Path::new(&marker).exists());
        }
        for call in [3, 6, 9] {
            for soft in [false, true] {
                let status = crate::supervise::run(&argv, || {
                    let mut sys = Fake::new(libc::RLIM_INFINITY, libc::RLIM_INFINITY);
                    sys.mismatch = Some((call, soft));
                    apply_with(&LIMITS, &mut sys)
                })
                .unwrap();
                assert_eq!(status, std::process::ExitCode::from(125));
                assert!(!std::path::Path::new(&marker).exists());
            }
        }
    }
}
