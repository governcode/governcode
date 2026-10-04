/* Controlled static target. No connect, bind, send, DNS, or external addresses.
 * Unsandboxed socket controls only create and immediately close ordinary sockets.
 * All file paths are supplied by an owner-only fixture directory. */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/* Common native x86_64/aarch64 number; older libc headers may omit it. */
#define FIXTURE_FCHMODAT2 452
#define REQUIRE(test) do { if (!(test)) { \
    fprintf(stderr, "line %d: %s (errno=%d)\n", __LINE__, #test, errno); return 1; \
} } while (0)
#define DENIED(call) do { errno = 0; long rc = (call); REQUIRE(rc == -1 && errno == EPERM); } while (0)

static int network_denials(void) {
    const int kinds[] = {SOCK_STREAM, SOCK_DGRAM, SOCK_RAW, SOCK_RDM,
                         SOCK_SEQPACKET, SOCK_DCCP, SOCK_PACKET, 0, -1, INT_MAX};
    const int flags[] = {0, SOCK_CLOEXEC, SOCK_NONBLOCK, SOCK_CLOEXEC | SOCK_NONBLOCK};
    const int protocols[] = {0, IPPROTO_TCP, IPPROTO_UDP, IPPROTO_RAW, -1, INT_MAX};
    /* Linux header-defined AF values are contiguous [AF_UNSPEC, AF_MAX).
     * Include invalid family values too; seccomp must win before dispatch. */
    for (int family = -1; family <= AF_MAX; family++) {
        for (size_t t = 0; t < sizeof(kinds) / sizeof(kinds[0]); t++) {
            for (size_t f = 0; f < sizeof(flags) / sizeof(flags[0]); f++) {
                for (size_t p = 0; p < sizeof(protocols) / sizeof(protocols[0]); p++) {
                    int pair[2] = {-1, -1};
                    DENIED(syscall(SYS_socket, family, kinds[t] | flags[f], protocols[p]));
                    DENIED(syscall(SYS_socketpair, family, kinds[t] | flags[f], protocols[p], pair));
                    REQUIRE(pair[0] == -1 && pair[1] == -1);
                }
            }
        }
    }
    DENIED(syscall(SYS_socket, INT_MAX, INT_MAX, INT_MAX));
    DENIED(syscall(SYS_socketpair, AF_UNIX, SOCK_STREAM, 0, NULL));
    DENIED(socket(AF_INET, SOCK_STREAM, 0));
    int pair[2];
    DENIED(socketpair(AF_UNIX, SOCK_STREAM, 0, pair));
    /* Invalid inputs never create a ring, including in positive/default tests. */
    DENIED(syscall(SYS_io_uring_setup, 0, NULL));
    DENIED(syscall(SYS_io_uring_enter, -1, 0, 0, 0, NULL, 0));
    DENIED(syscall(SYS_io_uring_register, -1, 0, NULL, 0));
    puts("socket/socketpair matrix and io_uring entrypoints: EPERM");
    return 0;
}

static int socket_controls(int old_abi) {
    const int flags[] = {0, SOCK_CLOEXEC, SOCK_NONBLOCK, SOCK_CLOEXEC | SOCK_NONBLOCK};
    for (size_t f = 0; f < sizeof(flags) / sizeof(flags[0]); f++) {
        for (int family = 0; family < 2; family++) {
            for (int type = 0; type < 2; type++) {
                int fd = socket(family ? AF_INET6 : AF_INET,
                                (type ? SOCK_DGRAM : SOCK_STREAM) | flags[f], 0);
                REQUIRE(fd >= 0);
                REQUIRE(close(fd) == 0);
            }
        }
        for (int type = 0; type < 3; type++) {
            int kind = type == 0 ? SOCK_STREAM : type == 1 ? SOCK_DGRAM : SOCK_SEQPACKET;
            int fd = socket(AF_UNIX, kind | flags[f], 0);
            if (old_abi) REQUIRE(fd == -1 && errno == EACCES);
            else { REQUIRE(fd >= 0); REQUIRE(close(fd) == 0); }
            int pair[2];
            int rc = socketpair(AF_UNIX, kind | flags[f], 0, pair);
            if (old_abi && kind == SOCK_DGRAM) REQUIRE(rc == -1 && errno == EACCES);
            else { REQUIRE(rc == 0); REQUIRE(close(pair[0]) == 0 && close(pair[1]) == 0); }
        }
    }
    puts("socket controls: created and immediately closed");
    return 0;
}

static int mode_result(long rc, const char *path, int restricted, int modern) {
    int error = errno;
    struct stat st;
    REQUIRE(stat(path, &st) == 0);
    if (restricted) {
        REQUIRE(rc == -1 && error == EPERM);
        REQUIRE((st.st_mode & 07777) == 0600);
    } else if (modern && rc == -1 && error == ENOSYS) {
        REQUIRE((st.st_mode & 07777) == 0600);
        puts("SKIP fchmodat2 positive control: ENOSYS");
    } else {
        REQUIRE(rc == 0);
        REQUIRE((st.st_mode & 07777) == 0640);
        REQUIRE(chmod(path, 0600) == 0);
    }
    return 0;
}

static int modes(const char *work, const char *outside, int restricted) {
    const char *paths[] = {work, outside};
    for (size_t i = 0; i < 2; i++) {
        const char *path = paths[i];
        /* outside is genuinely ungranted in the restricted run: no preopened fd. */
        int fd = open(path, O_RDONLY | O_CLOEXEC);
        if (restricted && i == 1) REQUIRE(fd == -1 && errno == EACCES);
        else REQUIRE(fd >= 0);
        REQUIRE(mode_result(chmod(path, 0640), path, restricted, 0) == 0);
        REQUIRE(mode_result(fchmodat(AT_FDCWD, path, 0640, 0), path, restricted, 0) == 0);
        REQUIRE(mode_result(fchmodat(AT_FDCWD, path, 0640, AT_SYMLINK_NOFOLLOW), path, restricted, 1) == 0);
#ifdef SYS_chmod
        REQUIRE(mode_result(syscall(SYS_chmod, path, 0640), path, restricted, 0) == 0);
#endif
        REQUIRE(mode_result(syscall(SYS_fchmodat, AT_FDCWD, path, 0640), path, restricted, 0) == 0);
        for (size_t f = 0; f < 2; f++) {
            int flags = f ? AT_SYMLINK_NOFOLLOW : 0;
            REQUIRE(mode_result(syscall(FIXTURE_FCHMODAT2, AT_FDCWD, path, 0640, flags), path, restricted, 1) == 0);
        }
        if (fd >= 0) {
            REQUIRE(mode_result(fchmod(fd, 0640), path, restricted, 0) == 0);
            REQUIRE(mode_result(syscall(SYS_fchmod, fd, 0640), path, restricted, 0) == 0);
            REQUIRE(mode_result(syscall(FIXTURE_FCHMODAT2, fd, "", 0640, AT_EMPTY_PATH), path, restricted, 1) == 0);
            REQUIRE(close(fd) == 0);
        }
    }
    if (restricted) {
#ifdef SYS_chmod
        DENIED(syscall(SYS_chmod, NULL, UINT_MAX));
#endif
        DENIED(syscall(SYS_fchmod, -1, UINT_MAX));
        DENIED(syscall(SYS_fchmodat, -1, NULL, UINT_MAX));
        DENIED(syscall(FIXTURE_FCHMODAT2, -1, NULL, UINT_MAX, INT_MAX));
        DENIED(syscall(FIXTURE_FCHMODAT2, -1, "", 0640, AT_EMPTY_PATH));
    }
    puts(restricted ? "chmod wrappers/raw syscalls: EPERM, modes unchanged" : "chmod positive controls: modes changed and restored");
    return 0;
}

static int io_and_limits(const char *work) {
    int pair[2];
    REQUIRE(pipe(pair) == 0);
    REQUIRE(write(pair[1], "p", 1) == 1);
    char c;
    REQUIRE(read(pair[0], &c, 1) == 1 && c == 'p');
    REQUIRE(close(pair[0]) == 0 && close(pair[1]) == 0);
    REQUIRE(pipe2(pair, O_CLOEXEC) == 0);
    REQUIRE(write(pair[1], "q", 1) == 1);
    REQUIRE(read(pair[0], &c, 1) == 1 && c == 'q');
    REQUIRE(close(pair[0]) == 0 && close(pair[1]) == 0);
    int fd = open(work, O_RDWR);
    REQUIRE(fd >= 0 && write(fd, "x", 1) == 1);
    REQUIRE(lseek(fd, 0, SEEK_SET) == 0 && read(fd, &c, 1) == 1 && c == 'x');
    REQUIRE(close(fd) == 0);
    int resources[] = {RLIMIT_CPU, RLIMIT_AS, RLIMIT_NOFILE};
    rlim_t requested[] = {2, 64 * 1024 * 1024, 32};
    for (size_t i = 0; i < 3; i++) {
        struct rlimit limit;
        REQUIRE(getrlimit(resources[i], &limit) == 0);
        REQUIRE(limit.rlim_cur == requested[i] && limit.rlim_max == requested[i]);
        limit.rlim_cur++; limit.rlim_max++;
        errno = 0;
        REQUIRE(setrlimit(resources[i], &limit) == -1 && errno == EPERM);
    }
    puts("file/pipe I/O and unraisable CPU/AS/FD ceilings verified");
    return 0;
}

int main(int argc, char **argv) {
    alarm(10); /* Finite even if a test's independent wall watchdog fails. */
    REQUIRE(argc >= 4);
    const char *mode = argv[1], *work = argv[2], *outside = argv[3];
    if (!strcmp(mode, "control") || !strcmp(mode, "default-old-abi")) {
        REQUIRE(socket_controls(!strcmp(mode, "default-old-abi")) == 0);
        return modes(work, outside, 0);
    }
    if (!strcmp(mode, "restricted") || !strcmp(mode, "exec-child")) {
        REQUIRE(network_denials() == 0);
        REQUIRE(modes(work, outside, 1) == 0);
        REQUIRE(io_and_limits(work) == 0);
        if (!strcmp(mode, "restricted")) {
            pid_t child = fork();
            REQUIRE(child >= 0);
            if (child == 0) {
                alarm(8);
                if (network_denials() != 0) _exit(1);
                execl(argv[0], argv[0], "exec-child", work, outside, (char *)NULL);
                _exit(2);
            }
            int status;
            REQUIRE(waitpid(child, &status, 0) == child);
            REQUIRE(WIFEXITED(status) && WEXITSTATUS(status) == 0);
            puts("restrictions inherited through finite fork/exec");
        }
        return 0;
    }
    if (!strcmp(mode, "hold")) {
        REQUIRE(io_and_limits(work) == 0);
        fflush(stdout);
        while (1) pause(); /* Bounded by alarm, watchdog, and the test's SIGTERM. */
    }
    if (!strcmp(mode, "marker")) {
        int fd = open(work, O_WRONLY | O_CREAT | O_TRUNC, 0600);
        REQUIRE(fd >= 0 && close(fd) == 0);
        return 0;
    }
    if (!strcmp(mode, "files")) {
        int fds[128], count = 0;
        for (; count < 128; count++) {
            fds[count] = open(work, O_RDONLY);
            if (fds[count] < 0) break;
        }
        int error = errno;
        for (int i = 0; i < count; i++) close(fds[i]);
        REQUIRE(count > 0 && count < 128 && error == EMFILE);
        puts("EMFILE"); return 0;
    }
    if (!strcmp(mode, "address-space")) {
        void *maps[16]; int count = 0;
        size_t bytes = 8 * 1024 * 1024;
        for (; count < 16; count++) {
            maps[count] = mmap(NULL, bytes, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
            if (maps[count] == MAP_FAILED) break;
        }
        int error = errno;
        for (int i = 0; i < count; i++) munmap(maps[i], bytes);
        REQUIRE(count > 0 && count < 16 && error == ENOMEM);
        puts("ENOMEM"); return 0;
    }
    if (!strcmp(mode, "cpu")) {
        REQUIRE(signal(SIGXCPU, SIG_IGN) != SIG_ERR);
        puts("SIGXCPU ignored"); fflush(stdout);
        volatile unsigned long counter = 0;
        while (1) { counter++; (void)counter; }
    }
    return 2;
}
