#include <algorithm>
#include <array>
#include <iostream>
#include <list>
#include <unordered_set>
#include <utility>
#include <vector>

int missing();
struct Constructor {
  Constructor() { missing(); }
};
struct Destructor {
  ~Destructor() { missing(); }
};
struct Virtual {
  virtual int run() { return missing(); }
};
struct Copy {
  Copy() {}
  Copy(const Copy&) { missing(); }
};
struct Default {
  int value;
  Default() { missing(); }
  Default(int n) : value(n) {}
};

struct Value { int n; };
int main() {
  std::vector<Copy> noCopies(1);
  Default reversed[] = {1, 2};
  std::reverse(reversed, reversed + 2);
  std::array<Value, 1> a{{{1}}}, b{{{2}}};
  int& arrayMember = a[0].n;
  std::swap(a, b);
  std::cout << arrayMember << a[0].n;
  std::pair<Value, int> p(Value{3}, 0), q(Value{4}, 0);
  int& pairMember = p.first.n;
  std::swap(p, q);
  std::cout << pairMember << p.first.n;
  std::unordered_set<int> values{7};
  auto i = values.begin();
  const int& item = *i;
  values.rehash(100);
  std::cout << item;
  std::array<std::list<int>, 1> left{{{8}}}, right{{{9}}};
  auto original = left[0].begin();
  std::swap(left, right);
  std::cout << *original << (original == right[0].begin());
  auto nested = std::pair<std::list<int>, int>({{5}, 6});
  auto other = std::pair<std::list<int>, int>({{7}, 8});
  auto position = nested.first.begin();
  std::swap(nested, other);
  std::cout << *position << (position == other.first.begin()) << other.second;
}
