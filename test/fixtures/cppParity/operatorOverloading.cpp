#include <iostream>
#include <string>
struct V {
  int x, y;
  V operator+(const V& o) const { return {x + o.x, y + o.y}; }
  V& operator+=(const V& o) { x += o.x; y += o.y; return *this; }
  V operator-() const { return {-x, -y}; }
  bool operator==(const V& o) const { return x == o.x && y == o.y; }
  int operator[](int i) const { return i == 0 ? x : y; }
  V& operator++() { ++x; return *this; }
  V operator++(int) { V old = *this; ++y; return old; }
  explicit operator bool() const { return x != 0 || y != 0; }
};
V operator*(int k, const V& v) { return {k * v.x, k * v.y}; }
std::ostream& operator<<(std::ostream& os, const V& v) { return os << "(" << v.x << ", " << v.y << ")"; }
bool operator<(const V& a, const V& b) { return a.x < b.x; }
struct Adder {
  int base;
  int operator()(int a) const { return base + a; }
  int operator()(int a, int b) const { return base + a + b; }
};
struct Wrapper {
  V v{7, 8};
  V* operator->() { return &v; }
  V& operator*() { return v; }
};
struct Celsius {
  double c;
  operator double() const { return c; }
};
enum Color { RED, GREEN };
std::ostream& operator<<(std::ostream& os, Color c) { return os << (c == RED ? "red" : "green"); }
int main() {
  V a{1, 2}, b{3, 4};
  V c = a + b;
  std::cout << c << " " << -a << " " << 2 * b << "\n";
  c += a;
  std::cout << c << (a == b) << (a != b) << (a < b) << c[0] << c[1] << "\n";
  V d = c++;
  ++c;
  std::cout << d << c << "\n";
  if (a) std::cout << "truthy\n";
  Adder add{10};
  std::cout << add(1) << " " << add(1, 2) << "\n";
  Wrapper w;
  std::cout << w->x << (*w).y << "\n";
  Celsius t{36.5};
  double dd = t;
  std::cout << dd + 1 << " " << t * 2 << "\n";
  std::cout << RED << " " << GREEN << "\n";
}
