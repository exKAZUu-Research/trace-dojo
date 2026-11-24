#include <iostream>
#include <array>
constexpr int fact(int n) { return n <= 1 ? 1 : n * fact(n - 1); }
constexpr int fib(int n) { int a = 0, b = 1; for (int i = 0; i < n; ++i) { int t = a + b; a = b; b = t; } return a; }
consteval int square(int x) { return x * x; }
template <class T> auto describe(T x) {
  if constexpr (sizeof(T) == 1) return 'c';
  else if constexpr (sizeof(T) == 4) return x * 2;
  else return x;
}
constexpr bool inConstant() { if consteval { return true; } else { return false; } }
constinit int counter = 5;
volatile int flag = 1;
int main() {
  int arr[fact(4)];
  std::array<int, fib(6)> a{};
  static_assert(fact(5) == 120);
  constexpr int s = square(7);
  std::cout << sizeof(arr) / sizeof(int) << " " << a.size() << " " << s << " " << square(3) << "\n";
  std::cout << describe('x') << " " << describe(21) << " " << describe(2.5) << "\n";
  constexpr bool c = inConstant();
  std::cout << c << inConstant() << counter << flag << fact(5) << "\n";
  switch (5) { case fact(3) - 1: std::cout << "five\n"; break; }
}
