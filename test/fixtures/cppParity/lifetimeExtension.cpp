#include <iostream>
#include <string>
#include <vector>

struct M {
  int id;
  M(int i) : id(i) { std::cout << "C" << id << " "; }
  M(const M& other) : id(other.id + 10) { std::cout << "cp" << id << " "; }
  ~M() { std::cout << "D" << id << " "; }
};

struct Inner {
  M m{1};
  int v = 7;
};

struct Outer {
  Inner in;
  M n{2};
};

struct Base {
  virtual ~Base() { std::cout << "~Base "; }
};

struct Derived : Base {
  ~Derived() { std::cout << "~Derived "; }
};

struct Holder {
  std::vector<int> v{1, 2, 3};
  ~Holder() { std::cout << "~Holder "; }
};

Holder makeHolder() { return Holder(); }

std::vector<M> makeVector() {
  std::vector<M> v;
  v.reserve(2);
  v.emplace_back(3);
  v.emplace_back(4);
  return v;
}

M make(int i) { return M(i); }

struct RefHolder { const M& m; int k; };
struct IntRef { const int& a; int b; };

int main() {
  { const int& r = Outer().in.v; std::cout << "use " << r << " "; } std::cout << "\n";
  { const M& m = Outer().in.m; std::cout << "use " << m.id << " "; } std::cout << "\n";
  { const auto& n = Outer().n; std::cout << "use " << n.id << " "; } std::cout << "\n";
  { const Base& b = Derived(); std::cout << "use "; } std::cout << "\n";
  { const M& m = make(5); std::cout << "use " << m.id << " "; } std::cout << "\n";
  { const std::string& s = std::to_string(42); std::cout << s << " "; } std::cout << "\n";
  {
    for (auto& m : makeVector()) std::cout << "x" << m.id << " ";
    std::cout << "after ";
  }
  std::cout << "\n";
  {
    for (int x : makeHolder().v) std::cout << x << " ";
    std::cout << "after ";
  }
  std::cout << "\n";
  for (const auto& m : std::vector<M>{M(6)}) std::cout << "x" << m.id << " ";
  std::cout << "\n";
  { RefHolder h{M(7), 2}; std::cout << "use " << h.m.id << h.k << " "; } std::cout << "\n";
  { IntRef r{10, 2}; std::cout << r.a << r.b << "\n"; }
}
