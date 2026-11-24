extern "C" int abs(int);
extern "C" {
int twice(int x);
}
#include <cstdio>
int twice(int x) { return 2 * x; }
int main() {
  _Pragma("clang diagnostic push")
  printf("%d %d\n", abs(-3), twice(4));
}
