#include <cstddef>
#include <iostream>
#include <map>
#include <string>
#include <vector>

struct Base { int first = 2; };
struct Derived : Base { int second = 4; };
struct FixedBase { int first; FixedBase(int value) : first(value) {} };
struct FixedDerived : FixedBase { int second; };

struct Abstract { virtual int value(int n) const = 0; };
struct Intermediate : Abstract { int value(const int n) const override = 0; };
struct Concrete : Intermediate { int value(int n) const { return ++n; } };

struct Holder {
  std::vector<int> values;
  std::string name;
  Holder(const std::vector<int>& source, const std::string& title) : values{source}, name{title} {}
};

int twice(int value) { return value * 2; }

int main() {
  Derived a{{1}, 3}, b{5, 6}, c{};
  FixedDerived d{7, 8};
  const int& held = Derived{{9}, 10}.first;
  std::cout << a.first << a.second << b.first << b.second << c.first << c.second << d.first << d.second
            << held << '\n';
  Holder h({1, 2, 3}, "n");
  std::map<int, int> original{{1, 2}};
  std::map<int, int> copy{original};
  std::vector<int> v{h.values};
  v = {h.values};
  std::vector<std::vector<int>> nested{v};
  std::vector<std::vector<int>> nestedCopy{nested};
  std::cout << h.values[/* index */ 1] << h.name << copy.at(1) << nestedCopy[0].size() << '\n';
  Concrete impl;
  Intermediate* iface = &impl;
  Intermediate* null = NULL;
  std::cout << (/* dispatch */ iface->value(6)) << twice(/* argument */ 3) << (null == nullptr) << '\n';
  unsigned char bytes[] = "\xc3\xa9";
  std::cout << int(bytes[0]) << ' ' << int(bytes[1]) << '\n';
}
