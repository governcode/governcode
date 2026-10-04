/* Invented finite targets: at most three descendants, each exits within 5 seconds.
 * No networking, external artifacts, or host-PID /proc inspection. The transport
 * forgery case attempts only its own /proc descriptor directory. */
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
static int write_all(int fd, const void *data, size_t length) {
    const char *bytes = data;
    while (length) {
        ssize_t n = write(fd, bytes, length);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return -1;
        bytes += n;
        length -= (size_t)n;
    }
    return 0;
}
/* This is deliberately a finite fixture reader, not a general JSON parser.
 * Accept only the numeric request IDs and methods emitted by our fixture client. */
static int line(char *buffer, size_t capacity) {
    size_t n = 0;
    while (n + 1 < capacity) {
        char byte;
        ssize_t count = read(0, &byte, 1);
        if (count < 0 && errno == EINTR) continue;
        if (count == 0) return n == 0 ? 1 : -1;
        if (count < 0 || byte == '\0') return -1;
        if (byte == '\n') { buffer[n] = '\0'; return 0; }
        buffer[n++] = byte;
    }
    return -1;
}
static int request_id(const char *buffer, unsigned *id) {
    const char *p = strstr(buffer, "\"id\"");
    if (!p) return -1;
    p += 4;
    while (*p == ' ' || *p == '\t') ++p;
    if (*p++ != ':') return -1;
    while (*p == ' ' || *p == '\t') ++p;
    if (*p < '0' || *p > '9') return -1;
    unsigned value = 0, digits = 0;
    while (*p >= '0' && *p <= '9') {
        if (++digits > 6) return -1;
        value = value * 10 + (unsigned)(*p++ - '0');
    }
    while (*p == ' ' || *p == '\t') ++p;
    if (*p != ',' && *p != '}') return -1;
    *id = value;
    return 0;
}
static int response(unsigned id, const char *result) {
    char buffer[2048];
    int n = snprintf(buffer, sizeof(buffer), "{\"jsonrpc\":\"2.0\",\"id\":%u,\"result\":%s}\n", id, result);
    return n > 0 && (size_t)n < sizeof(buffer) ? write_all(1, buffer, (size_t)n) : -1;
}
static int acp(const char *mode) {
    char buffer[8192];
    static const char session[] = "{\"sessionId\":\"fixture-session\",\"configOptions\":[{\"id\":\"mode\",\"name\":\"Mode\",\"type\":\"select\",\"currentValue\":\"fixture\",\"options\":[{\"value\":\"fixture\",\"name\":\"Fixture\"}]}]}";
    unsigned session_id = 0;
    int initialized = 0, awaiting_refusal = 0;
    for (unsigned count = 0; count < 4; ++count) {
        unsigned id;
        int read_status = line(buffer, sizeof(buffer));
        /* Discovery may stop and close stdin before its rejection is delivered.
         * EOF is a finite cancellation, never a validated rejection marker. */
        if (read_status == 1 && awaiting_refusal) return 0;
        if (read_status || request_id(buffer, &id)) return 117;
        if (awaiting_refusal) {
            if (id != 100 || !strstr(buffer, "\"error\"") || !strstr(buffer, "\"code\"")
                || strstr(buffer, "\"result\"") || strstr(buffer, "\"method\"")) return 118;
            marker("forbidden-rejected");
            return response(session_id, session) ? 119 : 0;
        }
        if (strstr(buffer, "\"initialize\"") && !initialized) {
            if (!strcmp(mode, "acp-hang")) {
                marker("hung-request");
                for (;;) pause(); /* alarm(5) is independent of client cancellation. */
            }
            if (response(id, "{\"protocolVersion\":1,\"agentCapabilities\":{\"loadSession\":false},\"agentInfo\":{\"name\":\"fixture-agent\",\"version\":\"1.0.0\"},\"authMethods\":[]}")) return 119;
            initialized = 1;
        } else if (strstr(buffer, "\"session/new\"") && initialized) {
            if (!strcmp(mode, "acp-forbidden")) {
                session_id = id;
                awaiting_refusal = 1;
                static const char forbidden[] = "{\"jsonrpc\":\"2.0\",\"id\":100,\"method\":\"fs/read_text_file\",\"params\":{\"sessionId\":\"fixture-session\",\"path\":\"/fixture/denied\"}}\n";
                if (write_all(1, forbidden, sizeof(forbidden) - 1)) return 119;
            } else {
                return response(id, session) ? 119 : 0;
            }
        } else return 120;
    }
    return 121;
}
static int forge_transport(const char *invocation) {
    unsigned char record[32] = {'G', 'P', 'L', 'T', 1, 1, 1, 0};
    if (strlen(invocation) != 32) return 122;
    for (int i = 0; i < 16; ++i) {
        unsigned value = 0;
        for (int j = 0; j < 2; ++j) {
            char c = invocation[i * 2 + j];
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return 122;
            value = value * 16 + (unsigned)(c <= '9' ? c - '0' : c - 'a' + 10);
        }
        record[8 + i] = (unsigned char)value;
    }
    for (int fd = 3; fd < 64; ++fd) {
        errno = 0;
        if (fcntl(fd, F_GETFD) != -1 || errno != EBADF) return 123;
        errno = 0;
        if (dup(fd) != -1 || errno != EBADF) return 124;
    }
    /* Landlock denies access to the target's descriptor directory; it cannot
     * reopen a proof alias. Neither pathname nor guessed pidfd grants access. */
    int fd = open("/proc/self/fd", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd >= 0) { close(fd); return 125; }
    fd = open("/proc/self/fd/4", O_WRONLY | O_CLOEXEC);
    if (fd >= 0) { close(fd); return 125; }
    errno = 0;
    if (syscall(SYS_pidfd_getfd, 3, 4, 0) != -1 || (errno != EPERM && errno != EBADF)) return 126;
    if (write_all(1, record, sizeof(record))) return 127;
    marker("forge-rejected");
    return 0;
}
int main(int argc, char **argv) {
    if (argc != 2 && argc != 3) return 92;
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
    if (!strcmp(argv[1], "acp") || !strcmp(argv[1], "acp-forbidden") || !strcmp(argv[1], "acp-hang")) return acp(argv[1]);
    if (!strcmp(argv[1], "stdout-flood") || !strcmp(argv[1], "stderr-flood")) {
        char bytes[4096];
        memset(bytes, 'x', sizeof(bytes));
        int fd = !strcmp(argv[1], "stdout-flood") ? 1 : 2;
        marker("flood-ready");
        /* Finite 256 KiB output; blocking consumer failures remain alarm-bounded. */
        for (int i = 0; i < 64; ++i) if (write_all(fd, bytes, sizeof(bytes))) return 128;
        return 0;
    }
    if (!strcmp(argv[1], "forge")) {
        if (argc == 3) return forge_transport(argv[2]);
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
    if (!strcmp(argv[1], "direct") || !strcmp(argv[1], "double")
        || (argc == 3 && !strcmp(argv[1], "detach"))) return 0;
    if (!strcmp(argv[1], "signal-tree")) { raise(SIGTERM); return 116; }
    signal(SIGTERM, SIG_IGN);
    sleep(5);
    return 0;
}
