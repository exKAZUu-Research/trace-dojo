export const PLATFORM_DECLARATIONS: Record<string, string> = {
  'stdio.h': `

typedef long ssize_t;
typedef long long off_t;
typedef char * va_list;
typedef unsigned long long syscall_arg_t;
typedef long long user_off_t;
typedef long long user_time_t;
typedef unsigned long long user_ulong_t;
typedef long long user_long_t;
typedef long long user_ssize_t;
typedef unsigned long long user_size_t;
typedef unsigned long long user_addr_t;
typedef unsigned long uintptr_t;
typedef long intptr_t;
typedef long long register_t;
typedef unsigned long long u_int64_t;
typedef unsigned int u_int32_t;
typedef unsigned short u_int16_t;
typedef unsigned char u_int8_t;
typedef long long int64_t;
typedef int int32_t;
typedef short int16_t;
typedef signed char int8_t;
int __snprintf_chk(char *, size_t, int, size_t, const char *, ...);
int __sprintf_chk(char *, int, size_t, const char *, ...);
int __sputc(int, FILE *);
int __srget(FILE *);
int __svfscanf(FILE *, const char *, char *);
int __swbuf(int, FILE *);
int __vsnprintf_chk(char *, size_t, int, size_t, const char *, char *);
int __vsprintf_chk(char *, int, size_t, const char *, char *);
int asprintf(char **, const char *, ...);
char *ctermid(char *);
char *ctermid_r(char *);
int dprintf(int, const char *, ...);
FILE *fdopen(int, const char *);
char *fgetln(FILE *, size_t *);
int fileno(FILE *);
void flockfile(FILE *);
FILE *fmemopen(void *, size_t, const char *);
const char *fmtcheck(const char *, const char *);
int fpurge(FILE *);
int fseeko(FILE *, long long, int);
long long ftello(FILE *);
int ftrylockfile(FILE *);
void funlockfile(FILE *);
FILE *funopen(const void *, int (* )(void *, char *, int), int (* )(void *, const char *, int), fpos_t (* )(void *, fpos_t, int), int (* )(void *));
int getc_unlocked(FILE *);
int getchar_unlocked(void);
long getdelim(char **, size_t *, int, FILE *);
long getline(char **, size_t *, FILE *);
int getw(FILE *);
FILE *open_memstream(char **, size_t *);
int pclose(FILE *);
FILE *popen(const char *, const char *);
int putc_unlocked(int, FILE *);
int putchar_unlocked(int);
int putw(int, FILE *);
int renameat(int, const char *, int, const char *);
int renameatx_np(int, const char *, int, const char *, unsigned int);
int renamex_np(const char *, const char *, unsigned int);
void setbuffer(FILE *, char *, int);
int setlinebuf(FILE *);
char *tempnam(const char *, const char *);
int vasprintf(char **, const char *, char *);
int vdprintf(int, const char *, char *);
`,
  'stdlib.h': `
struct __darwin_mcontext64;
struct __darwin_sigaltstack;
struct __darwin_ucontext;
struct __siginfo;
struct _malloc_zone_t;
struct _opaque_pthread_attr_t;
struct rlimit;
struct rusage;
struct rusage_info_v6;
typedef unsigned short mode_t;
typedef int dev_t;
typedef struct _malloc_zone_t malloc_zone_t;
typedef unsigned long long malloc_type_id_t;
typedef int wchar_t;
typedef int rune_t;
typedef int ct_rune_t;
typedef struct rusage_info_v6 rusage_info_current;
typedef void * rusage_info_t;
typedef unsigned long long rlim_t;
typedef unsigned long uintmax_t;
typedef long intmax_t;
typedef unsigned long long uint_fast64_t;
typedef unsigned int uint_fast32_t;
typedef unsigned short uint_fast16_t;
typedef unsigned char uint_fast8_t;
typedef long long int_fast64_t;
typedef int int_fast32_t;
typedef short int_fast16_t;
typedef signed char int_fast8_t;
typedef unsigned long long uint_least64_t;
typedef unsigned int uint_least32_t;
typedef unsigned short uint_least16_t;
typedef unsigned char uint_least8_t;
typedef long long int_least64_t;
typedef int int_least32_t;
typedef short int_least16_t;
typedef signed char int_least8_t;
typedef unsigned long long uint64_t;
typedef unsigned int uint32_t;
typedef unsigned short uint16_t;
typedef unsigned char uint8_t;
typedef void (*sig_t)(int);
typedef struct __siginfo siginfo_t;
typedef unsigned int uid_t;
typedef unsigned int sigset_t;
typedef struct __darwin_ucontext ucontext_t;
typedef struct __darwin_sigaltstack stack_t;
typedef struct _opaque_pthread_attr_t pthread_attr_t;
typedef struct __darwin_mcontext64 * mcontext_t;
typedef unsigned long long syscall_arg_t;
typedef long long user_off_t;
typedef long long user_time_t;
typedef unsigned long long user_ulong_t;
typedef long long user_long_t;
typedef long long user_ssize_t;
typedef unsigned long long user_size_t;
typedef unsigned long long user_addr_t;
typedef unsigned long uintptr_t;
typedef long intptr_t;
typedef long long register_t;
typedef unsigned long long u_int64_t;
typedef unsigned int u_int32_t;
typedef unsigned short u_int16_t;
typedef unsigned char u_int8_t;
typedef long long int64_t;
typedef int int32_t;
typedef short int16_t;
typedef signed char int8_t;
typedef int sig_atomic_t;
typedef unsigned int id_t;
typedef int pid_t;
unsigned short _OSSwapInt16(unsigned short);
unsigned int _OSSwapInt32(unsigned int);
unsigned long long _OSSwapInt64(unsigned long long);
unsigned int __builtin_bswap32(unsigned int);
unsigned long long __builtin_bswap64(unsigned long long);
long a64l(const char *);
void *alloca(size_t);
unsigned int arc4random(void);
void arc4random_addrandom(unsigned char *, int);
void arc4random_buf(void *, size_t);
void arc4random_stir(void);
unsigned int arc4random_uniform(unsigned int);
char *cgetcap(char *, const char *, int);
int cgetclose(void);
int cgetent(char **, char **, const char *);
int cgetfirst(char **, char **);
int cgetmatch(const char *, const char *);
int cgetnext(char **, char **);
int cgetnum(char *, const char *, long *);
int cgetset(const char *);
int cgetstr(char *, const char *, char **);
int cgetustr(char *, const char *, char **);
int daemon(int, int);
char *devname(int, unsigned short);
char *devname_r(int, unsigned short, char *, int);
char *ecvt(double, int, int *, int *);
char *fcvt(double, int, int *, int *);
char *gcvt(double, int, char *);
char *getbsize(int *, long *);
int getiopolicy_np(int, int);
int getloadavg(double *, int);
int getpriority(int, unsigned int);
const char *getprogname(void);
int getrlimit(int, struct rlimit *);
int getrusage(int, struct rusage *);
int getsubopt(char **, char *const *, char **);
int grantpt(int);
int heapsort(void *, size_t, size_t, int (* )(const void *, const void *));
char *l64a(long);
void *malloc_type_aligned_alloc(size_t, size_t, unsigned long long);
void *malloc_type_calloc(size_t, size_t, unsigned long long);
void malloc_type_free(void *, unsigned long long);
void *malloc_type_malloc(size_t, unsigned long long);
int malloc_type_posix_memalign(void **, size_t, size_t, unsigned long long);
void *malloc_type_realloc(void *, size_t, unsigned long long);
void *malloc_type_valloc(size_t, unsigned long long);
void *malloc_type_zone_calloc(struct _malloc_zone_t *, size_t, size_t, unsigned long long);
void malloc_type_zone_free(struct _malloc_zone_t *, void *, unsigned long long);
void *malloc_type_zone_malloc(struct _malloc_zone_t *, size_t, unsigned long long);
void *malloc_type_zone_memalign(struct _malloc_zone_t *, size_t, size_t, unsigned long long);
void *malloc_type_zone_realloc(struct _malloc_zone_t *, void *, size_t, unsigned long long);
void *malloc_type_zone_valloc(struct _malloc_zone_t *, size_t, unsigned long long);
int mergesort(void *, size_t, size_t, int (* )(const void *, const void *));
int mkstemp(char *);
char *mktemp(char *);
int posix_memalign(void **, size_t, size_t);
int posix_openpt(int);
void psort(void *, size_t, size_t, int (* )(const void *, const void *));
void psort_r(void *, size_t, size_t, void *, int (* )(void *, const void *, const void *));
char *ptsname(int);
int ptsname_r(int, char *, size_t);
int putenv(char *);
void qsort_r(void *, size_t, size_t, void *, int (* )(void *, const void *, const void *));
int radixsort(const unsigned char **, int, const unsigned char *, unsigned int);
int rand_r(unsigned int *);
void *reallocf(void *, size_t);
char *realpath(const char *, char *);
int rpmatch(const char *);
int setenv(const char *, const char *, int);
int setiopolicy_np(int, int, int);
void setkey(const char *);
int setpriority(int, unsigned int, int);
void setprogname(const char *);
int setrlimit(int, const struct rlimit *);
int sradixsort(const unsigned char **, int, const unsigned char *, unsigned int);
void sranddev(void);
void srandomdev(void);
long long strtonum(const char *, long long, long long, const char **);
long long strtoq(const char *, char **, int);
unsigned long long strtouq(const char *, char **, int);
int unlockpt(int);
int unsetenv(const char *);
void *valloc(size_t);
int wait(int *);
int wait3(int *, int, struct rusage *);
int wait4(int, int *, int, struct rusage *);
int waitpid(int, int *, int);
`,
  'string.h': `

typedef long ssize_t;
typedef unsigned long long syscall_arg_t;
typedef long long user_off_t;
typedef long long user_time_t;
typedef unsigned long long user_ulong_t;
typedef long long user_long_t;
typedef long long user_ssize_t;
typedef unsigned long long user_size_t;
typedef unsigned long long user_addr_t;
typedef unsigned long uintptr_t;
typedef long intptr_t;
typedef long long register_t;
typedef unsigned long long u_int64_t;
typedef unsigned int u_int32_t;
typedef unsigned short u_int16_t;
typedef unsigned char u_int8_t;
typedef long long int64_t;
typedef int int32_t;
typedef short int16_t;
typedef signed char int8_t;
int bcmp(const void *, const void *, size_t);
void bcopy(const void *, void *, size_t);
void bzero(void *, size_t);
int ffs(int);
int ffsl(long);
int ffsll(long long);
int fls(int);
int flsl(long);
int flsll(long long);
char *index(const char *, int);
void *memccpy(void *, const void *, int, size_t);
void *memmem(const void *, size_t, const void *, size_t);
void memset_pattern16(void *, const void *, size_t);
void memset_pattern4(void *, const void *, size_t);
void memset_pattern8(void *, const void *, size_t);
char *rindex(const char *, int);
char *stpcpy(char *, const char *);
char *stpncpy(char *, const char *, size_t);
char *strcasestr(const char *, const char *);
char *strchrnul(const char *, int);
int strerror_r(int, char *, size_t);
void strmode(int, char *);
size_t strnlen(const char *, size_t);
char *strnstr(const char *, const char *, size_t);
char *strsep(char **, const char *);
char *strsignal(int);
int strsignal_r(int, char *, size_t);
char *strtok_r(char *, const char *, char **);
void swab(const void *, void *, long);
int timingsafe_bcmp(const void *, const void *, size_t);
`,
  'ctype.h': `

typedef int wint_t;
typedef int wchar_t;
typedef int rune_t;
typedef int ct_rune_t;
typedef unsigned long size_t;
unsigned long ___runetype(int);
int ___tolower(int);
int ___toupper(int);
int __isctype(int, unsigned long);
int __istype(int, unsigned long);
int __maskrune(int, unsigned long);
int __tolower(int);
int __toupper(int);
int __wcwidth(int);
int digittoint(int);
int ishexnumber(int);
int isideogram(int);
int isnumber(int);
int isphonogram(int);
int isrune(int);
int isspecial(int);
`,
  'math.h': `
struct __double2;
struct __float2;
double __builtin_fabs(double);
float __builtin_fabsf(float);
long double __builtin_fabsl(long double);
double __builtin_inf(void);
long double __builtin_infl(void);
double __cospi(double);
float __cospif(float);
double __exp10(double);
float __exp10f(float);
int __fpclassifyd(double);
int __fpclassifyf(float);
int __fpclassifyl(long double);
int __inline_isfinited(double);
int __inline_isfinitef(float);
int __inline_isfinitel(long double);
int __inline_isinfd(double);
int __inline_isinff(float);
int __inline_isinfl(long double);
int __inline_isnand(double);
int __inline_isnanf(float);
int __inline_isnanl(long double);
int __inline_isnormald(double);
int __inline_isnormalf(float);
int __inline_isnormall(long double);
int __inline_signbitd(double);
int __inline_signbitf(float);
int __inline_signbitl(long double);
int __math_errhandling(void);
void __sincos(double, double *, double *);
struct __double2 __sincos_stret(double);
void __sincosf(float, float *, float *);
struct __float2 __sincosf_stret(float);
void __sincospi(double, double *, double *);
struct __double2 __sincospi_stret(double);
void __sincospif(float, float *, float *);
struct __float2 __sincospif_stret(float);
double __sinpi(double);
float __sinpif(float);
double __tanpi(double);
float __tanpif(float);
double j0(double);
double j1(double);
double jn(int, double);
double scalb(double, double);
double y0(double);
double y1(double);
double yn(int, double);
`,
  'inttypes.h': `

typedef int wchar_t;
intmax_t wcstoimax(const int *, int **, int);
uintmax_t wcstoumax(const int *, int **, int);
`,
  'errno.h': `

int *__error(void);
`,
};
export const PLATFORM_UNMODELED: Record<string, readonly string[]> = {
  'stdio.h': [],
  'stdlib.h': ['atexit_b', 'bsearch_b', 'heapsort_b', 'mergesort_b', 'psort_b', 'qsort_b', 'signal', 'waitid'],
  'string.h': [],
  'ctype.h': [],
  'math.h': [
    '__ceilf16',
    '__copysignf16',
    '__fabsf16',
    '__floorf16',
    '__fmaf16',
    '__fmaxf16',
    '__fminf16',
    '__hypotf16',
    '__nextafterf16',
    '__rintf16',
    '__roundf16',
    '__sqrtf16',
    '__truncf16',
  ],
  'inttypes.h': [],
  'errno.h': [],
};
export const PLATFORM_MACROS: Record<string, string> = {
  'stdio.h': `
int __trace_platform_getc_unlocked();
#define getc_unlocked(fp) __trace_platform_getc_unlocked(fp)
int __trace_platform_getchar_unlocked();
#define getchar_unlocked() __trace_platform_getchar_unlocked()
int __trace_platform_putc_unlocked();
#define putc_unlocked(x,fp) __trace_platform_putc_unlocked(x,fp)
int __trace_platform_putchar_unlocked();
#define putchar_unlocked(x) __trace_platform_putchar_unlocked(x)
`,
  'stdlib.h': `
int __trace_platform_alloca();
#define alloca(size) __trace_platform_alloca(size)
`,
  'string.h': `
int __trace_platform_bcopy();
#define bcopy(...) __trace_platform_bcopy(__VA_ARGS__)
int __trace_platform_bzero();
#define bzero(...) __trace_platform_bzero(__VA_ARGS__)
int __trace_platform_memccpy();
#define memccpy(...) __trace_platform_memccpy(__VA_ARGS__)
int __trace_platform_stpcpy();
#define stpcpy(...) __trace_platform_stpcpy(__VA_ARGS__)
int __trace_platform_stpncpy();
#define stpncpy(...) __trace_platform_stpncpy(__VA_ARGS__)
int __trace_platform_strlcat();
#define strlcat(...) __trace_platform_strlcat(__VA_ARGS__)
int __trace_platform_strlcpy();
#define strlcpy(...) __trace_platform_strlcpy(__VA_ARGS__)
`,
  'ctype.h': `

`,
  'math.h': `

`,
  'inttypes.h': `

`,
  'errno.h': `

`,
};

export const PLATFORM_DEFINED_FUNCTIONS = new Set([
  '_OSSwapInt16',
  '_OSSwapInt32',
  '_OSSwapInt64',
  '__inline_isfinited',
  '__inline_isfinitef',
  '__inline_isfinitel',
  '__inline_isinfd',
  '__inline_isinff',
  '__inline_isinfl',
  '__inline_isnand',
  '__inline_isnanf',
  '__inline_isnanl',
  '__inline_isnormald',
  '__inline_isnormalf',
  '__inline_isnormall',
  '__inline_signbitd',
  '__inline_signbitf',
  '__inline_signbitl',
  '__isctype',
  '__istype',
  '__sincos',
  '__sincosf',
  '__sincospi',
  '__sincospif',
  '__sputc',
  '__wcwidth',
  'digittoint',
  'isalnum',
  'isalpha',
  'isascii',
  'isblank',
  'iscntrl',
  'isdigit',
  'isgraph',
  'ishexnumber',
  'isideogram',
  'islower',
  'isnumber',
  'isphonogram',
  'isprint',
  'ispunct',
  'isrune',
  'isspace',
  'isspecial',
  'isupper',
  'isxdigit',
  'toascii',
  'tolower',
  'toupper',
]);
