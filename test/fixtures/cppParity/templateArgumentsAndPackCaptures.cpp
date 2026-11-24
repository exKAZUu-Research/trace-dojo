#include <cstdio>
template <class T> T twice(T x) { return x * 2; }
template int twice<int>(int);
template double twice(double);
template <class T> struct Box { T v; T get() const { return v; } };
template struct Box<int>;
template <class T> concept Num = requires(T a) { a + a; requires sizeof(T) >= 4; };
template <Num T> T add(T a, T b) { return a + b; }
template <class... A> auto capture(A... a) { return [a...] { return (a + ...); }; }
template <class... A> auto captureInit(A... a) { return [...xs = a] { return (xs * ...); }; }
enum class Color { Red, Green };
template <Color C> const char* name() { return C == Color::Red ? "red" : "green"; }
template <auto V> auto value() { return V; }
int main() {
  printf("%d %g %d\n", twice(2), twice(1.5), Box<int>{3}.get());
  printf("%d %ld\n", add(1, 2), add(3L, 4L));
  printf("%d %d\n", capture(1, 2, 3)(), captureInit(2, 3, 4)());
  printf("%s %s %d %c\n", name<Color::Red>(), name<Color::Green>(), value<5>(), value<'x'>());
}
