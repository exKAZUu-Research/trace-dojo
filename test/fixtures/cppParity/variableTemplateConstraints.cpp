#include <iostream>
#include <type_traits>
template <class T> inline constexpr bool B1 = !std::is_same_v<T, int>;
template <class T> inline constexpr bool B2 = std::is_same_v<T, char8_t>;
template <class T> requires B1<T> int f1(T) { return 1; }
template <class T> requires (!B2<T>) int f2(T) { return 2; }
int main() { std::cout << B1<unsigned> << B2<unsigned> << std::is_same_v<unsigned, char8_t> << "\n"; std::cout << f1(1u) << f2(1u) << "\n"; }
