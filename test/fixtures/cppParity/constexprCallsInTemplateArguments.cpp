#include <type_traits>
#include <cstdio>
template <class T, class... U>
constexpr unsigned long idx() {
  constexpr bool same[] = {std::is_same_v<T, U>..., false};
  unsigned long found = sizeof...(U);
  for (unsigned long i = 0; i < sizeof...(U); ++i) if (same[i]) found = i;
  return found;
}
template <class T, class... U>
constexpr unsigned long idx2() {
  unsigned long index = 0, found = sizeof...(U), count = 0;
  ((std::is_same_v<T, U> ? (found = index, ++count, ++index) : ++index), ...);
  return count == 1 ? found : sizeof...(U);
}
template <unsigned long N> struct S { static constexpr unsigned long v = N; };
int main() { printf("%lu %lu\n", idx<int, char, int>(), idx2<int, char, int>()); printf("%lu %lu\n", S<idx<int, char, int>()>::v, S<idx2<int, char, int>()>::v); }
