#include <array>
#include <iostream>
#include <unordered_set>
#include <utility>

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

struct Value { int n; };
int main() {
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
}
