#include <iostream>
[[noreturn]] void fail();
struct [[nodiscard]] S { int v = 4; };
[[nodiscard]] int g() { return 1; }
void h(int a [[maybe_unused]]) {}
__attribute__((unused)) static int counter = 2;
[[deprecated("old")]] int old() { return 7; }
int main() {
  [[maybe_unused]] int x = 5;
  int y [[gnu::unused]] = 6;
  switch (x) {
    case 5:
      std::cout << "five ";
      [[fallthrough]];
    case 6:
      std::cout << "six\n";
      break;
  }
  if (x > 0) [[likely]] { std::cout << "likely\n"; }
  [[assume(true)]];
  g();
  h(y);
  std::cout << S{}.v << counter << old() << "\n";
}
