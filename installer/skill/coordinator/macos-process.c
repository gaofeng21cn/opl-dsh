/* Report process identity and wait for exit without collecting argv or environment. */
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <unistd.h>

static int read_identity(pid_t pid, struct proc_bsdinfo *info) {
  errno = 0;
  int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, (int)sizeof(*info));
  if (size == (int)sizeof(*info) && info->pbi_pid == (unsigned)pid)
    return info->pbi_status == SZOMB ? 0 : 1;
  return size <= 0 && errno == ESRCH ? 0 : -1;
}

static int report_chain(pid_t pid, int count) {
  for (int index = 0; index < count && pid > 0; ++index) {
    struct proc_bsdinfo info, confirm;
    int result = read_identity(pid, &info);
    if (result <= 0) return result < 0 ? 1 : 0;
    char executable[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (proc_pidpath(pid, executable, sizeof(executable)) <= 0) return 1;
    if (read_identity(pid, &confirm) != 1 ||
        confirm.pbi_start_tvsec != info.pbi_start_tvsec ||
        confirm.pbi_start_tvusec != info.pbi_start_tvusec ||
        confirm.pbi_ppid != info.pbi_ppid) return 1;
    printf("%d\t%u\t%" PRIu64 "\t%" PRIu64 "\t", pid, info.pbi_ppid,
           (uint64_t)info.pbi_start_tvsec, (uint64_t)info.pbi_start_tvusec);
    for (const unsigned char *byte = (unsigned char *)executable; *byte; ++byte)
      printf("%02x", (unsigned)*byte);
    putchar('\n');
    const char *base = strrchr(executable, '/');
    if (base && strcmp(base + 1, "codex") == 0) break;
    pid = (pid_t)info.pbi_ppid;
  }
  return ferror(stdout) ? 1 : 0;
}

static int wait_for_exit(pid_t pid, uint64_t seconds, uint64_t micros) {
  int queue = kqueue();
  if (queue < 0) return 1;
  struct kevent event;
  EV_SET(&event, (uintptr_t)pid, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, NULL);
  int result = 1;
  if (kevent(queue, &event, 1, NULL, 0, NULL) < 0) {
    if (errno == ESRCH) result = 0;
    goto done;
  }
  struct proc_bsdinfo info;
  int identity = read_identity(pid, &info);
  if (identity < 0) goto done;
  if (identity == 0 || info.pbi_start_tvsec != seconds || info.pbi_start_tvusec != micros) {
    result = 0;
    goto done;
  }
  puts("waiting");
  if (fflush(stdout) != 0) goto done;
  int received;
  do {
    received = kevent(queue, NULL, 0, &event, 1, NULL);
  } while (received < 0 && errno == EINTR);
  if (received == 1 && event.ident == (uintptr_t)pid && event.filter == EVFILT_PROC &&
      !(event.flags & EV_ERROR) && (event.fflags & NOTE_EXIT)) result = 0;
done:
  close(queue);
  if (result == 0) puts("finished");
  return result;
}

static int parse_unsigned(const char *text, uint64_t *number) {
  if (!*text || strspn(text, "0123456789") != strlen(text)) return 0;
  errno = 0;
  *number = strtoull(text, NULL, 10);
  return errno == 0;
}

int main(int argc, char **argv) {
  uint64_t pid, seconds, micros;
  if (argc < 3 || !parse_unsigned(argv[2], &pid) || pid == 0 || pid > INT_MAX) return 2;
  if (argc == 3 && strcmp(argv[1], "inspect") == 0) return report_chain((pid_t)pid, 1);
  if (argc == 3 && strcmp(argv[1], "ancestors") == 0) return report_chain((pid_t)pid, 8);
  if (argc == 5 && strcmp(argv[1], "wait") == 0 &&
      parse_unsigned(argv[3], &seconds) && parse_unsigned(argv[4], &micros) && micros < 1000000)
    return wait_for_exit((pid_t)pid, seconds, micros);
  return 2;
}
