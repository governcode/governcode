/* Invented finite targets: at most three descendants, each exits within 5 seconds.
 * No networking, external artifacts, or host-PID /proc inspection. */
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static void marker(const char *name) {
    int fd = open(name, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd < 0 || write(fd, "fixture\n", 8) != 8) _exit(90);
    close(fd);
}
static void descendant(void) {
    alarm(5); /* Independent finite fallback, even with TERM ignored. */
    int pdeath = -1;
    if (setsid() < 0 || prctl(PR_SET_PDEATHSIG, SIGKILL) < 0 || prctl(PR_SET_PDEATHSIG, 0) < 0
        || prctl(PR_GET_PDEATHSIG, &pdeath) < 0 || pdeath != 0) _exit(91);
    signal(SIGTERM, SIG_IGN);
    marker("descendant-ready");
    usleep(800000);
    marker("late-activity");
    _exit(0);
}
int main(int argc, char **argv) {
    if (argc != 2) return 92;
    alarm(5);
    marker("executed");
    struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
    struct __user_cap_data_struct caps[2] = {{0}, {0}};
    if (syscall(SYS_capget, &header, caps) || caps[0].effective || caps[1].effective || caps[0].permitted || caps[1].permitted || caps[0].inheritable || caps[1].inheritable) return 109;
    if (prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1 || prctl(PR_GET_SECUREBITS, 0, 0, 0, 0) != 0xef) return 110;
    if (prctl(PR_CAPBSET_READ, 0, 0, 0, 0) != 0 || prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, 0, 0, 0) != 0) return 111;
    caps[0].effective = caps[0].permitted = 1;
    if (syscall(SYS_capset, &header, caps) != -1 || errno != EPERM) return 112;
    if (!strcmp(argv[1], "normal")) return 7;
    if (!strcmp(argv[1], "high-exit")) return 200;
    if (!strcmp(argv[1], "cpu")) { volatile unsigned long count = 0; for (;;) { ++count; (void)count; } }
    if (!strcmp(argv[1], "signal")) { raise(SIGTERM); return 93; }
    if (!strcmp(argv[1], "forge")) {
        puts("{\"termination\":true,\"pid\":1,\"closed\":true}");
        /* PID 1 is trusted, and Landlock signal scoping excludes the supervisor. */
        errno = 0;
        if (kill(1, SIGKILL) != -1 || errno != EPERM) return 94;
        if (syscall(SYS_pidfd_getfd, 3, 0, 0) != -1 || errno != EPERM) return 95;
        if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_RAISE, 0, 0, 0) != -1) return 96;
        for (int fd = 3; fd < 64; ++fd) {
            if (fcntl(fd, F_GETFD) != -1 || errno != EBADF) return 97;
        }
        marker("forge-rejected");
        return 0;
    }
    if (!strcmp(argv[1], "sandbox")) {
        struct rlimit limit;
        if (getrlimit(RLIMIT_NOFILE, &limit) || limit.rlim_cur > 32 || limit.rlim_max > 32) return 98;
        if (getrlimit(RLIMIT_CPU, &limit) || limit.rlim_cur > 2 || limit.rlim_max > 2) return 99;
        if (getrlimit(RLIMIT_AS, &limit) || limit.rlim_cur > 67108864 || limit.rlim_max > 67108864) return 100;
        errno = 0;
        if (socket(AF_INET, SOCK_STREAM, 0) != -1 || errno != EPERM) return 101;
        if (syscall(SYS_unshare, 0x20000000) != -1 || errno != EPERM) return 102;
        if (syscall(SYS_setns, -1, 0) != -1 || errno != EPERM) return 103;
        if (open("/etc/passwd", O_RDONLY) != -1) return 104;
        void *memory = mmap(NULL, 128 * 1024 * 1024, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (memory != MAP_FAILED || errno != ENOMEM) return 113;
        int fds[64], n = 0;
        while (n < 64 && (fds[n] = open("executed", O_RDONLY)) >= 0) ++n;
        if (n == 64 || errno != EMFILE) return 114;
        for (int i = 0; i < n; ++i) close(fds[i]);
        marker("sandbox-ok");
        return 0;
    }
    if (write(1, "fixture-output\n", 15) != 15) return 115;
    int pipefd[2];
    if (pipe(pipefd)) return 105;
    pid_t child = fork();
    if (child < 0) return 106;
    if (child == 0) {
        if (!strcmp(argv[1], "double")) {
            pid_t grandchild = fork();
            if (grandchild < 0) _exit(107);
            if (grandchild > 0) _exit(0);
        }
        /* Preserve ordinary inherited pipes and stdio; no proof descriptor exists. */
        descendant();
    }
    /* Wait for readiness via the allowlisted fixture marker, never /proc. */
    for (int i = 0; i < 200 && access("descendant-ready", F_OK); ++i) usleep(1000);
    if (access("descendant-ready", F_OK)) return 108;
    if (!strcmp(argv[1], "direct") || !strcmp(argv[1], "double")) return 0;
    if (!strcmp(argv[1], "signal-tree")) { raise(SIGTERM); return 116; }
    signal(SIGTERM, SIG_IGN);
    sleep(5);
    return 0;
}
