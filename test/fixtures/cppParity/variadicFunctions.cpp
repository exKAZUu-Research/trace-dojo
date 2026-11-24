#include <cstdarg>
#include <cstdio>
int sum(int count, ...) {
  va_list args;
  va_start(args, count);
  int total = 0;
  for (int i = 0; i < count; i++) total += va_arg(args, int);
  va_end(args);
  return total;
}
double average(int count, ...) {
  va_list args;
  va_start(args, count);
  double total = 0;
  for (int i = 0; i < count; i++) total += va_arg(args, double);
  va_end(args);
  return count ? total / count : 0;
}
void logf(const char* fmt, ...) {
  va_list args;
  va_start(args, fmt);
  vprintf(fmt, args);
  va_end(args);
}
int main() {
  printf("%d %d %g\n", sum(3, 1, 2, 3), sum(0), average(2, 1.5, 2.5));
  char c = 'x';
  float f = 1.5f;
  logf("%s %d %c %.1f\n", "hi", 7, c, f);
  printf("%zu\n", sizeof(va_list));
}
