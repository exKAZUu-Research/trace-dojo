#include <iostream>
template <class T>
constexpr T pi = T(3.1415926535897932385L);
template <class T>
T zero = T();
template <int N>
constexpr int square = N * N;
template <class T, class U>
constexpr bool same = false;
template <class T>
constexpr bool same<T, T> = true;
int main() {
  std::cout << pi<double> << " " << pi<float> << " " << pi<int> << "\n";
  zero<int> = 5;
  std::cout << zero<int> << " " << zero<long> << "\n";
  static_assert(square<4> == 16);
  int arr[square<3>];
  std::cout << sizeof(arr) / sizeof(arr[0]) << "\n";
}
template <class T> struct Wrap { T v; };
template <class T> constexpr bool is_wrap = false;
template <class T> constexpr bool is_wrap<Wrap<T>> = true;
template <> constexpr bool is_wrap<char> = true;
int f() {
  std::cout << same<int, int> << same<int, long> << is_wrap<Wrap<int>> << is_wrap<int> << is_wrap<char> << "\n";
  return 0;
}
int dummy = f();
