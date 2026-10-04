/* Fork-style clone3, with no Rust return site reached in the child. No shared
 * address space, stack, files, fs, signal handlers, threads, or parent relation.
 * The callback cannot return or unwind. Called only in a fresh single-thread process. */
#include <linux/sched.h>
#include <signal.h>
#include <stdint.h>
#include <sys/syscall.h>
#include <unistd.h>

long gs_probe_clone(int *pidfd, void (*child)(void *), void *context) {
    struct clone_args args = {0};
    args.flags = CLONE_NEWUSER | CLONE_NEWPID | CLONE_PIDFD;
    args.pidfd = (uint64_t)(uintptr_t)pidfd;
    args.exit_signal = SIGCHLD;
    long result = syscall(SYS_clone3, &args, sizeof(args));
    if (result == 0) {
        child(context);
        _exit(125);
    }
    return result;
}
