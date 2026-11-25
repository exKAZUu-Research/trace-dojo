#include <cstdarg>
#include <cstdio>
int readTwo(const char* text, const char* format, ...) {
  va_list args;
  va_start(args, format);
  int n = vsscanf(text, format, args);
  va_end(args);
  return n;
}
int main() {
  int a = 0, b = 0;
  int n = readTwo("12 34", "%d %d", &a, &b);
  printf("%d %d %d\n", n, a, b);
  char word[8];
  n = readTwo("abc 5", "%7s %d", word, &a);
  printf("%d %s %d\n", n, word, a);
}
