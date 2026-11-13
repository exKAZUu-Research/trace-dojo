import type { HeaderLookup } from '../preprocessor';
import { unsupportedMessage } from '../unsupported';

/** The interpreter's own declarations, which every program sees without including anything. */
export const TURTLE_HEADER = `
typedef struct __turtle Turtle;
Turtle *new_turtle();
void 前に進む(Turtle *turtle);
void forward(Turtle *turtle);
void 後に戻る(Turtle *turtle);
void backward(Turtle *turtle);
void 右を向く(Turtle *turtle);
void turnRight(Turtle *turtle);
void 左を向く(Turtle *turtle);
void turnLeft(Turtle *turtle);
_Bool 前に進めるか(Turtle *turtle);
_Bool canMoveForward(Turtle *turtle);
_Bool 前のマスが塗られているか(Turtle *turtle);
void remove();
`;

const SIZE_T = 'typedef unsigned long size_t;';
const NULL = '#define NULL ((void *)0)';

const STDIO = `
${SIZE_T}
${NULL}
typedef struct __sFILE FILE;
typedef long fpos_t;
extern FILE *stdin;
extern FILE *stdout;
extern FILE *stderr;
#define EOF (-1)
#define BUFSIZ 1024
#define FILENAME_MAX 1024
#define FOPEN_MAX 20
#define L_tmpnam 1024
#define TMP_MAX 308915776
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2
#define _IOFBF 0
#define _IOLBF 1
#define _IONBF 2
int printf(const char *format, ...);
int fprintf(FILE *stream, const char *format, ...);
int sprintf(char *str, const char *format, ...);
int snprintf(char *str, size_t size, const char *format, ...);
int puts(const char *s);
int putchar(int c);
int fputs(const char *s, FILE *stream);
int fputc(int c, FILE *stream);
int putc(int c, FILE *stream);
int fflush(FILE *stream);
void perror(const char *s);
size_t fwrite(const void *ptr, size_t size, size_t count, FILE *stream);
void setbuf(FILE *stream, char *buffer);
int setvbuf(FILE *stream, char *buffer, int mode, size_t size);
int sscanf(const char *str, const char *format, ...);
int scanf(const char *format, ...);
int fscanf(FILE *stream, const char *format, ...);
int getchar(void);
int getc(FILE *stream);
int fgetc(FILE *stream);
int ungetc(int c, FILE *stream);
char *fgets(char *s, int size, FILE *stream);
char *gets(char *s);
size_t fread(void *ptr, size_t size, size_t count, FILE *stream);
FILE *fopen(const char *path, const char *mode);
FILE *freopen(const char *path, const char *mode, FILE *stream);
int fclose(FILE *stream);
int feof(FILE *stream);
int ferror(FILE *stream);
void clearerr(FILE *stream);
int fseek(FILE *stream, long offset, int whence);
long ftell(FILE *stream);
void rewind(FILE *stream);
int fgetpos(FILE *stream, fpos_t *pos);
int fsetpos(FILE *stream, const fpos_t *pos);
int rename(const char *from, const char *to);
FILE *tmpfile(void);
char *tmpnam(char *s);
int vprintf(const char *format, char *ap);
int vfprintf(FILE *stream, const char *format, char *ap);
int vsprintf(char *str, const char *format, char *ap);
int vsnprintf(char *str, size_t size, const char *format, char *ap);
int vsscanf(const char *str, const char *format, char *ap);
int vscanf(const char *format, char *ap);
int vfscanf(FILE *stream, const char *format, char *ap);
`;

const STDLIB = `
${SIZE_T}
${NULL}
#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1
#define RAND_MAX 0x7fffffff
#define MB_CUR_MAX 1
typedef struct { int quot; int rem; } div_t;
typedef struct { long quot; long rem; } ldiv_t;
typedef struct { long long quot; long long rem; } lldiv_t;
void *malloc(size_t size);
void *calloc(size_t count, size_t size);
void *realloc(void *ptr, size_t size);
void free(void *ptr);
int abs(int x);
long labs(long x);
long long llabs(long long x);
div_t div(int x, int y);
ldiv_t ldiv(long x, long y);
lldiv_t lldiv(long long x, long long y);
int atoi(const char *s);
long atol(const char *s);
long long atoll(const char *s);
double atof(const char *s);
long strtol(const char *s, char **end, int base);
unsigned long strtoul(const char *s, char **end, int base);
long long strtoll(const char *s, char **end, int base);
unsigned long long strtoull(const char *s, char **end, int base);
double strtod(const char *s, char **end);
float strtof(const char *s, char **end);
long double strtold(const char *s, char **end);
int rand(void);
void srand(unsigned int seed);
void qsort(void *base, size_t count, size_t size, int (*compare)(const void *, const void *));
void *bsearch(const void *key, const void *base, size_t count, size_t size, int (*compare)(const void *, const void *));
void exit(int status);
void _Exit(int status);
void abort(void);
int atexit(void (*function)(void));
char *getenv(const char *name);
int system(const char *command);
void *aligned_alloc(size_t alignment, size_t size);
int mblen();
int mbtowc();
int wctomb();
size_t mbstowcs();
size_t wcstombs();
int at_quick_exit();
void quick_exit(int status);
`;

const STRING = `
${SIZE_T}
${NULL}
size_t strlen(const char *s);
char *strcpy(char *dst, const char *src);
char *strncpy(char *dst, const char *src, size_t n);
char *strcat(char *dst, const char *src);
char *strncat(char *dst, const char *src, size_t n);
int strcmp(const char *a, const char *b);
int strncmp(const char *a, const char *b, size_t n);
int strcoll(const char *a, const char *b);
char *strchr(const char *s, int c);
char *strrchr(const char *s, int c);
char *strstr(const char *haystack, const char *needle);
char *strtok(char *s, const char *separators);
size_t strspn(const char *s, const char *accept);
size_t strcspn(const char *s, const char *reject);
char *strpbrk(const char *s, const char *accept);
char *strdup(const char *s);
char *strndup(const char *s, size_t n);
char *strerror(int error);
size_t strxfrm(char *dst, const char *src, size_t n);
void *memcpy(void *dst, const void *src, size_t n);
void *memmove(void *dst, const void *src, size_t n);
void *memset(void *s, int c, size_t n);
int memcmp(const void *a, const void *b, size_t n);
void *memchr(const void *s, int c, size_t n);
`;

const CTYPE = `
int isalnum(int c);
int isalpha(int c);
int isblank(int c);
int iscntrl(int c);
int isdigit(int c);
int isgraph(int c);
int islower(int c);
int isprint(int c);
int ispunct(int c);
int isspace(int c);
int isupper(int c);
int isxdigit(int c);
int tolower(int c);
int toupper(int c);
`;

const MATH_FUNCTIONS_1 = [
  'acos',
  'asin',
  'atan',
  'cos',
  'sin',
  'tan',
  'acosh',
  'asinh',
  'atanh',
  'cosh',
  'sinh',
  'tanh',
  'exp',
  'exp2',
  'expm1',
  'log',
  'log10',
  'log2',
  'log1p',
  'logb',
  'sqrt',
  'cbrt',
  'fabs',
  'ceil',
  'floor',
  'round',
  'trunc',
  'rint',
  'nearbyint',
  'erf',
  'erfc',
  'tgamma',
  'lgamma',
];
const MATH_FUNCTIONS_2 = [
  'atan2',
  'pow',
  'fmod',
  'remainder',
  'hypot',
  'fmin',
  'fmax',
  'fdim',
  'copysign',
  'nextafter',
];

const MATH = `
#define M_E 2.71828182845904523536028747135266250
#define M_LOG2E 1.44269504088896340735992468100189214
#define M_LOG10E 0.434294481903251827651128918916605082
#define M_LN2 0.693147180559945309417232121458176568
#define M_LN10 2.30258509299404568401799145468436421
#define M_PI 3.14159265358979323846264338327950288
#define M_PI_2 1.57079632679489661923132169163975144
#define M_PI_4 0.785398163397448309615660845819875721
#define M_1_PI 0.318309886183790671537767526745028724
#define M_2_PI 0.636619772367581343075535053490057448
#define M_2_SQRTPI 1.12837916709551257389615890312154517
#define M_SQRT2 1.41421356237309504880168872420969808
#define M_SQRT1_2 0.707106781186547524400844362104849039
#define HUGE_VAL __builtin_huge_val()
#define HUGE_VALF __builtin_huge_valf()
#define HUGE_VALL __builtin_huge_val()
#define INFINITY __builtin_inff()
#define NAN __builtin_nanf("")
#define FP_NAN 1
#define FP_INFINITE 2
#define FP_ZERO 3
#define FP_NORMAL 4
#define FP_SUBNORMAL 5
#define MATH_ERRNO 1
#define MATH_ERREXCEPT 2
#define math_errhandling 2
#define isnan(x) __builtin_isnan(x)
#define isinf(x) __builtin_isinf(x)
#define isfinite(x) __builtin_isfinite(x)
#define isnormal(x) __builtin_isnormal(x)
#define signbit(x) __builtin_signbit(x)
#define fpclassify(x) __builtin_fpclassify(x)
#define isgreater(x, y) __builtin_isgreater(x, y)
#define isgreaterequal(x, y) __builtin_isgreaterequal(x, y)
#define isless(x, y) __builtin_isless(x, y)
#define islessequal(x, y) __builtin_islessequal(x, y)
#define islessgreater(x, y) __builtin_islessgreater(x, y)
#define isunordered(x, y) __builtin_isunordered(x, y)
typedef float float_t;
typedef double double_t;
double __builtin_huge_val(void);
float __builtin_huge_valf(void);
float __builtin_inff(void);
float __builtin_nanf(const char *tag);
int __builtin_isnan();
int __builtin_isinf();
int __builtin_isfinite();
int __builtin_isnormal();
int __builtin_signbit();
int __builtin_fpclassify();
int __builtin_isgreater();
int __builtin_isgreaterequal();
int __builtin_isless();
int __builtin_islessequal();
int __builtin_islessgreater();
int __builtin_isunordered();
${[...MATH_FUNCTIONS_1].map((name) => `double ${name}(double x);\nfloat ${name}f(float x);\nlong double ${name}l(long double x);`).join('\n')}
${MATH_FUNCTIONS_2.map((name) => `double ${name}(double x, double y);\nfloat ${name}f(float x, float y);\nlong double ${name}l(long double x, long double y);`).join('\n')}
double fma(double x, double y, double z);
float fmaf(float x, float y, float z);
long lround(double x);
long lroundf(float x);
long long llround(double x);
long long llroundf(float x);
long lrint(double x);
long long llrint(double x);
double modf(double x, double *integer);
float modff(float x, float *integer);
double frexp(double x, int *exponent);
float frexpf(float x, int *exponent);
double ldexp(double x, int exponent);
float ldexpf(float x, int exponent);
double scalbn(double x, int exponent);
int ilogb(double x);
double nan(const char *tag);
float nanf(const char *tag);
double remquo(double x, double y, int *quotient);
`;

/** On arm64 macOS, a va_list is a char * to the extra arguments, which lie in 8-byte slots. */
const STDARG = `
typedef char *va_list;
typedef char *__gnuc_va_list;
#define va_start(ap, last) __builtin_va_start(ap, last)
#define va_end(ap) ((void)(ap))
#define va_copy(destination, source) ((destination) = (source))
#define __va_copy(destination, source) ((destination) = (source))
void __builtin_va_start();
void __va_arg_is_declared(void);
`;

const TIME = `
${SIZE_T}
${NULL}
typedef long time_t;
typedef unsigned long clock_t;
#define CLOCKS_PER_SEC 1000000
struct tm {
  int tm_sec;
  int tm_min;
  int tm_hour;
  int tm_mday;
  int tm_mon;
  int tm_year;
  int tm_wday;
  int tm_yday;
  int tm_isdst;
  long tm_gmtoff;
  char *tm_zone;
};
time_t time(time_t *t);
clock_t clock(void);
double difftime(time_t end, time_t start);
time_t mktime(struct tm *tm);
struct tm *gmtime(const time_t *t);
struct tm *localtime(const time_t *t);
char *asctime(const struct tm *tm);
char *ctime(const time_t *t);
size_t strftime(char *buffer, size_t size, const char *format, const struct tm *tm);
`;

const STDBOOL = `
#define bool _Bool
#define true 1
#define false 0
#define __bool_true_false_are_defined 1
`;

const STDDEF = `
${SIZE_T}
${NULL}
typedef long ptrdiff_t;
typedef long max_align_t;
void __offsetof_is_declared(void);
`;

const LIMITS = `
#define CHAR_BIT 8
#define MB_LEN_MAX 6
#define SCHAR_MIN (-128)
#define SCHAR_MAX 127
#define UCHAR_MAX 255
#define CHAR_MIN (-128)
#define CHAR_MAX 127
#define SHRT_MIN (-32768)
#define SHRT_MAX 32767
#define USHRT_MAX 65535
#define INT_MIN (-2147483647 - 1)
#define INT_MAX 2147483647
#define UINT_MAX 4294967295U
#define LONG_MIN (-9223372036854775807L - 1)
#define LONG_MAX 9223372036854775807L
#define ULONG_MAX 18446744073709551615UL
#define LLONG_MIN (-9223372036854775807L - 1)
#define LLONG_MAX 9223372036854775807L
#define ULLONG_MAX 18446744073709551615UL
`;

const FLOAT = `
#define FLT_RADIX 2
#define FLT_MANT_DIG 24
#define DBL_MANT_DIG 53
#define LDBL_MANT_DIG 53
#define FLT_DIG 6
#define DBL_DIG 15
#define LDBL_DIG 15
#define FLT_MIN_EXP (-125)
#define DBL_MIN_EXP (-1021)
#define LDBL_MIN_EXP (-1021)
#define FLT_MIN_10_EXP (-37)
#define DBL_MIN_10_EXP (-307)
#define LDBL_MIN_10_EXP (-307)
#define FLT_MAX_EXP 128
#define DBL_MAX_EXP 1024
#define LDBL_MAX_EXP 1024
#define FLT_MAX_10_EXP 38
#define DBL_MAX_10_EXP 308
#define LDBL_MAX_10_EXP 308
#define FLT_MAX 3.40282347e+38F
#define DBL_MAX 1.7976931348623157e+308
#define LDBL_MAX 1.7976931348623157e+308L
#define FLT_EPSILON 1.19209290e-7F
#define DBL_EPSILON 2.2204460492503131e-16
#define LDBL_EPSILON 2.2204460492503131e-16L
#define FLT_MIN 1.17549435e-38F
#define DBL_MIN 2.2250738585072014e-308
#define LDBL_MIN 2.2250738585072014e-308L
#define FLT_TRUE_MIN 1.40129846e-45F
#define DBL_TRUE_MIN 4.9406564584124654e-324
#define LDBL_TRUE_MIN 4.9406564584124654e-324L
#define FLT_DECIMAL_DIG 9
#define DBL_DECIMAL_DIG 17
#define LDBL_DECIMAL_DIG 17
#define DECIMAL_DIG 17
#define FLT_EVAL_METHOD 0
#define FLT_ROUNDS 1
#define FLT_HAS_SUBNORM 1
#define DBL_HAS_SUBNORM 1
#define LDBL_HAS_SUBNORM 1
`;

const STDINT = `
typedef signed char int8_t;
typedef short int16_t;
typedef int int32_t;
typedef long long int64_t;
typedef unsigned char uint8_t;
typedef unsigned short uint16_t;
typedef unsigned int uint32_t;
typedef unsigned long long uint64_t;
typedef int8_t int_least8_t;
typedef int16_t int_least16_t;
typedef int32_t int_least32_t;
typedef int64_t int_least64_t;
typedef uint8_t uint_least8_t;
typedef uint16_t uint_least16_t;
typedef uint32_t uint_least32_t;
typedef uint64_t uint_least64_t;
typedef int8_t int_fast8_t;
typedef int16_t int_fast16_t;
typedef int32_t int_fast32_t;
typedef int64_t int_fast64_t;
typedef uint8_t uint_fast8_t;
typedef uint16_t uint_fast16_t;
typedef uint32_t uint_fast32_t;
typedef uint64_t uint_fast64_t;
typedef long intptr_t;
typedef unsigned long uintptr_t;
typedef long intmax_t;
typedef unsigned long uintmax_t;
#define INT8_MIN (-128)
#define INT16_MIN (-32768)
#define INT32_MIN (-2147483647 - 1)
#define INT64_MIN (-9223372036854775807L - 1)
#define INT8_MAX 127
#define INT16_MAX 32767
#define INT32_MAX 2147483647
#define INT64_MAX 9223372036854775807L
#define UINT8_MAX 255
#define UINT16_MAX 65535
#define UINT32_MAX 4294967295U
#define UINT64_MAX 18446744073709551615UL
#define INT_LEAST8_MIN INT8_MIN
#define INT_LEAST16_MIN INT16_MIN
#define INT_LEAST32_MIN INT32_MIN
#define INT_LEAST64_MIN INT64_MIN
#define INT_LEAST8_MAX INT8_MAX
#define INT_LEAST16_MAX INT16_MAX
#define INT_LEAST32_MAX INT32_MAX
#define INT_LEAST64_MAX INT64_MAX
#define UINT_LEAST8_MAX UINT8_MAX
#define UINT_LEAST16_MAX UINT16_MAX
#define UINT_LEAST32_MAX UINT32_MAX
#define UINT_LEAST64_MAX UINT64_MAX
#define INT_FAST8_MIN INT8_MIN
#define INT_FAST16_MIN INT16_MIN
#define INT_FAST32_MIN INT32_MIN
#define INT_FAST64_MIN INT64_MIN
#define INT_FAST8_MAX INT8_MAX
#define INT_FAST16_MAX INT16_MAX
#define INT_FAST32_MAX INT32_MAX
#define INT_FAST64_MAX INT64_MAX
#define UINT_FAST8_MAX UINT8_MAX
#define UINT_FAST16_MAX UINT16_MAX
#define UINT_FAST32_MAX UINT32_MAX
#define UINT_FAST64_MAX UINT64_MAX
#define INTPTR_MIN INT64_MIN
#define INTPTR_MAX INT64_MAX
#define UINTPTR_MAX UINT64_MAX
#define INTMAX_MIN INT64_MIN
#define INTMAX_MAX INT64_MAX
#define UINTMAX_MAX UINT64_MAX
#define PTRDIFF_MIN INT64_MIN
#define PTRDIFF_MAX INT64_MAX
#define SIZE_MAX UINT64_MAX
#define INT8_C(v) (v)
#define INT16_C(v) (v)
#define INT32_C(v) (v)
#define INT64_C(v) (v ## L)
#define UINT8_C(v) (v)
#define UINT16_C(v) (v)
#define UINT32_C(v) (v ## U)
#define UINT64_C(v) (v ## UL)
#define INTMAX_C(v) (v ## L)
#define UINTMAX_C(v) (v ## UL)
`;

const INTTYPES = `
${STDINT}
#define PRId8 "hhd"
#define PRId16 "hd"
#define PRId32 "d"
#define PRId64 "lld"
#define PRIi8 "hhi"
#define PRIi16 "hi"
#define PRIi32 "i"
#define PRIi64 "lli"
#define PRIu8 "hhu"
#define PRIu16 "hu"
#define PRIu32 "u"
#define PRIu64 "llu"
#define PRIo8 "hho"
#define PRIo16 "ho"
#define PRIo32 "o"
#define PRIo64 "llo"
#define PRIx8 "hhx"
#define PRIx16 "hx"
#define PRIx32 "x"
#define PRIx64 "llx"
#define PRIX8 "hhX"
#define PRIX16 "hX"
#define PRIX32 "X"
#define PRIX64 "llX"
#define PRIdMAX "jd"
#define PRIuMAX "ju"
#define PRIxMAX "jx"
#define PRIdPTR "ld"
#define PRIuPTR "lu"
#define PRIxPTR "lx"
typedef struct { intmax_t quot; intmax_t rem; } imaxdiv_t;
intmax_t imaxabs(intmax_t x);
imaxdiv_t imaxdiv(intmax_t x, intmax_t y);
intmax_t strtoimax(const char *s, char **end, int base);
uintmax_t strtoumax(const char *s, char **end, int base);
`;

const ASSERT = `
#ifdef NDEBUG
#define assert(e) ((void)0)
#else
#define assert(e) ((e) ? (void)0 : __assert_rtn(#e, __LINE__))
#endif
void __assert_rtn(const char *expression, int line);
#define static_assert _Static_assert
`;

const ERRNO = `
extern int errno;
#define EPERM 1
#define ENOENT 2
#define EINTR 4
#define EIO 5
#define ENOMEM 12
#define EACCES 13
#define EEXIST 17
#define EINVAL 22
#define ENOSPC 28
#define EDOM 33
#define ERANGE 34
#define EILSEQ 92
`;

const ISO646 = `
#define and &&
#define and_eq &=
#define bitand &
#define bitor |
#define compl ~
#define not !
#define not_eq !=
#define or ||
#define or_eq |=
#define xor ^
#define xor_eq ^=
`;

const HEADERS: Record<string, string> = {
  'stdio.h': STDIO,
  'stdarg.h': STDARG,
  'time.h': TIME,
  'stdlib.h': STDLIB,
  'string.h': STRING,
  'ctype.h': CTYPE,
  'math.h': MATH,
  'stdbool.h': STDBOOL,
  'stddef.h': STDDEF,
  'limits.h': LIMITS,
  'float.h': FLOAT,
  'stdint.h': STDINT,
  'inttypes.h': INTTYPES,
  'assert.h': ASSERT,
  'errno.h': ERRNO,
  'iso646.h': ISO646,
};

/** The standard headers the interpreter leaves out, with what learners call what they provide. */
const UNSUPPORTED_HEADERS: Record<string, string> = {
  'threads.h': 'スレッド（threads.h）',
  'pthread.h': 'スレッド（pthread.h）',
  'stdatomic.h': '原子的な操作（stdatomic.h）',
  'setjmp.h': 'setjmp.h',
  'signal.h': 'シグナル（signal.h）',
  'wchar.h': 'ワイド文字（wchar.h）',
  'wctype.h': 'ワイド文字（wctype.h）',
  'uchar.h': 'Unicode の文字型（uchar.h）',
  'locale.h': 'ロケール（locale.h）',
  'complex.h': '複素数（complex.h）',
  'tgmath.h': '型総称の数学関数（tgmath.h）',
  'fenv.h': '浮動小数点数の環境（fenv.h）',
  'stdalign.h': 'stdalign.h',
  'stdnoreturn.h': 'stdnoreturn.h',
  'stdbit.h': 'stdbit.h',
  'stdckdint.h': 'stdckdint.h',
};

/** Finds the header that `#include` names, or why the program cannot include it. */
export const lookupHeader: HeaderLookup = (name, quoted) => {
  const text = HEADERS[name];
  if (text !== undefined) return { text };
  const feature = UNSUPPORTED_HEADERS[name];
  if (feature) return { refusal: unsupportedMessage(feature) };
  return {
    refusal: unsupportedMessage(
      quoted ? `自分で作ったヘッダや別のファイル（#include "${name}"）` : `標準ライブラリ以外のヘッダ（<${name}>）`
    ),
  };
};
