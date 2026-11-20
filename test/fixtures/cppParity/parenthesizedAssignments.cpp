#include <iostream>

int advance(int n) { return n + 1; }
int echo(int n) { return n; }

int main() {
  int i = 0;
  while ((i = advance(i), i < 4)) std::cout << i;
  int result = (i += 2, i = advance(i), i + 2);
  std::cout << ' ' << result << echo((i = 3, i + 1)) << ' ';
  for (; (i = advance(i), i < 6);) std::cout << i;
}
