#include <iostream>
#include <vector>
#include <utility>
#include <array>
#include <map>
#include <set>
#include <string>
template <class T> struct Box { T v; Box(T x) : v(x) {} };
template <class T, class U> struct Two { T a; U b; Two(T x, U y) : a(x), b(y) {} };
template <class T> struct Agg { T x; T y; };
template <class T> struct Named { T value; Named(const char* s) : value(s) {} };
Named(const char*) -> Named<std::string>;
template <class T> struct Holder { T v; template <class U> Holder(U u, int) : v(u) {} };
template <class T> Holder(T, int) -> Holder<T>;
int main() {
  Box b(3);
  Box c{2.5};
  Box d = b;
  Box e = Box(7);
  auto f = Box{'x'};
  Two t(1, std::string("s"));
  Agg a{1, 2};
  Named n("abc");
  Holder h(1.5, 0);
  std::cout << b.v << " " << c.v << " " << d.v << " " << e.v << " " << f.v << " " << t.b << " " << a.y << " " << n.value.size() << " " << h.v << "\n";
  std::vector v{1, 2, 3};
  std::vector w(3, 2.5);
  std::pair p(1, 2.5);
  std::array arr{1, 2, 3, 4};
  std::set s{3, 1, 2};
  std::vector copy = v;
  std::pair q{std::string("k"), 'c'};
  std::cout << v.size() << " " << w[2] << " " << p.second << " " << arr.size() << " " << *s.begin() << " " << copy.size() << " " << q.first << q.second << "\n";
  std::map m{std::pair{1, std::string("one")}, std::pair{2, std::string("two")}};
  std::cout << m[2] << " " << sizeof(arr) << "\n";
}
