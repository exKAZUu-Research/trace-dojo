#include <iostream>
#include <list>
#include <vector>

struct A {
  int v;
  A(int x) : v(x) { std::cout << "C" << v << ' '; }
  A(const A& o) : v(o.v) { std::cout << "cp" << v << ' '; }
  ~A() { std::cout << "D" << v << ' '; }
};

int main() {
  A x(9);
  {
    std::cout << "\n[reserved]";
    std::vector<A> d;
    d.reserve(12);
    for (int i = 0; i < 6; i++) d.emplace_back(i);
    std::cout << "\n1: "; d.insert(d.begin() + 2, x);
    std::cout << "\n2: "; d.insert(d.begin() + 5, x);
    std::cout << "\n3: "; d.insert(d.begin() + 1, A(8));
    std::cout << "\n4: "; d.insert(d.begin() + 1, 2, x);
    std::cout << "\n5: "; d.insert(d.end() - 1, 2, x);
    std::cout << "\n6: "; d.emplace(d.begin() + 1, 7);
    std::cout << "\n7: "; d.erase(d.begin() + 1);
    std::cout << "\n8: "; d.erase(d.end() - 2);
    std::cout << "\n9: "; d.erase(d.begin() + 1, d.begin() + 3);
    std::cout << "\n10: "; d.insert(d.begin() + 1, d[3]);
    std::cout << "\n11: "; d.resize(4, x);
    std::cout << "\n12: "; d.resize(6, x);
    std::cout << "\n13: "; d.assign(3, x);
    std::cout << "\n14: "; d.assign(5, A(4));
    std::cout << "\n15: "; std::vector<A> e; e.emplace_back(1); e = d;
    std::cout << "\n16: "; d.pop_back();
    std::cout << "\n17: "; d.clear();
    std::cout << "\nend: ";
  }
  {
    std::cout << "\n[growing]";
    std::vector<A> d;
    for (int i = 0; i < 3; i++) d.emplace_back(i);
    std::cout << "\n1: "; d.insert(d.begin() + 1, x);
    std::cout << "\n2: "; d.insert(d.begin() + 2, 3, x);
    std::cout << "\n3: "; d.emplace(d.begin() + 1, 5);
    std::cout << "\n4: "; d.resize(12, x);
    std::cout << "\n5: "; d.resize(2, x);
    std::cout << "\n6: "; d.assign(30, x); std::cout << d.capacity();
    std::cout << "\n7: "; std::vector<A> e; e.emplace_back(1); e = d; std::cout << e.capacity();
    std::cout << "\n8: "; d.clear();
    std::cout << "\nend: ";
  }
  {
    std::cout << "\n[ranges]";
    std::list<A> l;
    l.emplace_back(1);
    l.emplace_back(2);
    std::vector<A> d;
    d.reserve(8);
    for (int i = 3; i < 6; i++) d.emplace_back(i);
    std::cout << "\n1: "; d.insert(d.begin() + 1, l.begin(), l.end());
    std::cout << "\n2: "; d.insert(d.end() - 1, l.begin(), l.end());
    std::cout << "\n3: "; d.insert(d.begin(), l.begin(), l.end());
    std::cout << "\n4: "; d.assign(l.begin(), l.end());
    std::cout << "\n5: "; d.insert(d.begin(), {A(7), A(8)});
    std::cout << "\n6: "; d.assign({A(6)});
    std::cout << "\n7: "; d = std::vector<A>(2, x); std::cout << d.capacity();
    std::cout << "\nend: ";
  }
  std::cout << "\n";
}
