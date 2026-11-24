#include <iostream>
#include <concepts>
#include <string>
template <class T> concept Small = sizeof(T) <= 2;
template <class T> concept Addable = requires (T a, T b) { a + b; { a * b } -> std::convertible_to<T>; };
template <class T> concept HasSize = requires (const T& t) { t.size(); typename T::value_type; };
template <std::integral T> T half(T x) { return x / 2; }
template <class T> requires std::floating_point<T> T half(T x) { return x / 2; }
template <class T> std::string kind(T) requires Small<T> { return "small"; }
template <class T> std::string kind(T) requires (!Small<T>) { return "large"; }
void show(std::integral auto x) { std::cout << "int:" << x << " "; }
void show(std::floating_point auto x) { std::cout << "float:" << x << " "; }
template <HasSize C> std::size_t sizeOf(const C& c) { return c.size(); }
template <class T> requires Addable<T> && (sizeof(T) >= 4) T add(T a, T b) { return a + b; }
int main() {
  std::cout << half(7) << " " << half(7.0) << "\n";
  std::cout << kind('a') << " " << kind(1.0) << "\n";
  show(3); show(2.5);
  std::cout << "\n";
  std::cout << sizeOf(std::string("abc")) << " " << add(2, 3) << "\n";
  std::cout << Small<char> << Small<int> << Addable<std::string> << HasSize<int> << std::same_as<int, int> << "\n";
  static_assert(std::integral<long> && !std::integral<double>);
}
