/* Controlled native target: no agents, bounded resources, at most one descendant. */
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

static const int resources[] = {RLIMIT_CPU, RLIMIT_AS, RLIMIT_NOFILE};

static int probe(char **values) {
    for (int i = 0; i < 3; i++) {
        struct rlimit limit;
        if (getrlimit(resources[i], &limit) != 0) return 10;
        if (limit.rlim_cur != (rlim_t)strtoull(values[2 * i], NULL, 10) ||
            limit.rlim_max != (rlim_t)strtoull(values[2 * i + 1], NULL, 10)) return 11;
        /* A child must not regain the hard ceiling even though syscalls are allowed. */
        if (limit.rlim_max == RLIM_INFINITY) continue;
        struct rlimit raised = limit;
        raised.rlim_max++;
        errno = 0;
        if (setrlimit(resources[i], &raised) == 0 || errno != EPERM) return 12;
        struct rlimit after;
        if (getrlimit(resources[i], &after) != 0 ||
            after.rlim_cur != limit.rlim_cur || after.rlim_max != limit.rlim_max) return 13;
    }
    return 0;
}

int main(int argc, char **argv) {
    /* Independent of CPU limits: the fixture always ends within eight wall seconds. */
    signal(SIGALRM, SIG_DFL);
    alarm(8);
    if (argc < 2) return 2;
    if (strcmp(argv[1], "marker") == 0 && argc == 3) {
        int fd = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC, 0600);
        if (fd < 0) return 3;
        close(fd);
        return 0;
    }
    if ((strcmp(argv[1], "probe") == 0 || strcmp(argv[1], "hold") == 0 ||
         strcmp(argv[1], "descendant") == 0) && argc == 8) {
        int result = probe(&argv[2]);
        if (result != 0) return result;
        if (strcmp(argv[1], "descendant") == 0) {
            pid_t child = fork();
            if (child < 0) return 14;
            if (child == 0) {
                alarm(8); /* Alarms are not inherited across fork. */
                _exit(probe(&argv[2]));
            }
            int status;
            if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) return 15;
            if (WEXITSTATUS(status) != 0) return WEXITSTATUS(status);
        }
        puts("limits verified");
        fflush(stdout);
        if (strcmp(argv[1], "hold") == 0) {
            while (1) pause(); /* The alarm bounds this even if the test fails. */
        }
        return 0;
    }
    if (strcmp(argv[1], "address-space") == 0) {
        /* At most 128 MiB virtual mappings, without touching or committing their pages. */
        void *maps[16];
        size_t bytes = 8 * 1024 * 1024;
        int count = 0, result = 20;
        for (; count < 16; count++) {
            maps[count] = mmap(NULL, bytes, PROT_READ | PROT_WRITE,
                               MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
            if (maps[count] == MAP_FAILED) {
                result = (errno == ENOMEM && count > 0) ? 0 : 21;
                break;
            }
        }
        for (int i = 0; i < count; i++) munmap(maps[i], bytes);
        if (result == 0) puts("ENOMEM");
        return result;
    }
    if (strcmp(argv[1], "files") == 0) {
        int fds[128];
        int count = 0, result = 22;
        for (; count < 128; count++) {
            fds[count] = open("/dev/null", O_RDONLY);
            if (fds[count] < 0) {
                result = (errno == EMFILE && count > 0) ? 0 : 23;
                break;
            }
        }
        for (int i = 0; i < count; i++) close(fds[i]);
        if (result == 0) puts("EMFILE");
        return result;
    }
    if (strcmp(argv[1], "cpu") == 0) {
        if (signal(SIGXCPU, SIG_IGN) == SIG_ERR) return 24;
        puts("SIGXCPU ignored");
        fflush(stdout);
        volatile unsigned long counter = 0;
        while (1) { counter++; (void)counter; } /* Finite hard CPU limit plus independent alarm/watchdog. */
    }
    return 2;
}
