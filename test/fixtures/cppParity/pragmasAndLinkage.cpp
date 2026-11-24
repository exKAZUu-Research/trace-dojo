#include <cstdio>
#define EXPORT __attribute__((unused))
_Pragma("clang diagnostic push")
int a[5] = {[1 ... 3] = 7};
EXPORT int g = 2;
int main() {
  int x = __extension__ (3 + 4);
  printf("%d %d %d %d\n", a[0], a[2], g, x);
}
