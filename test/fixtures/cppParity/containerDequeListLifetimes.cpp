#include <deque>
#include <iostream>
#include <iterator>
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
    std::cout << "\n[deque]";
    std::deque<A> d;
    for (int i = 0; i < 6; i++) d.emplace_back(i);
    std::cout << "\n1: "; d.insert(d.begin() + 2, x);
    std::cout << "\n2: "; d.insert(d.begin() + 5, x);
    std::cout << "\n3: "; d.insert(d.begin() + 1, A(8));
    std::cout << "\n4: "; d.insert(d.begin() + 1, 2, x);
    std::cout << "\n5: "; d.insert(d.end() - 1, 3, x);
    std::cout << "\n6: "; d.emplace(d.begin() + 1, 7);
    std::cout << "\n7: "; d.erase(d.begin() + 1);
    std::cout << "\n8: "; d.erase(d.end() - 2);
    std::cout << "\n9: "; d.erase(d.begin() + 1, d.begin() + 3);
    std::cout << "\n10: "; d.erase(d.end() - 4, d.end() - 2);
    std::cout << "\n11: "; d.insert(d.begin() + 1, d[3]);
    std::cout << "\n12: "; d.insert(d.begin() + 2, 3, d[1]);
    std::cout << "\n13: "; d.resize(4, x);
    std::cout << "\n14: "; d.resize(6, x);
    std::cout << "\n15: "; d.assign(3, x);
    std::cout << "\n16: "; d.assign(5, A(4));
    std::cout << "\n17: "; std::deque<A> e; e.emplace_back(1); e = d;
    std::cout << "\n18: "; d.emplace_front(3); d.push_front(x); d.pop_back();
    std::cout << "\n19: "; std::vector<A> v; v.reserve(4); v.emplace_back(5); v.emplace_back(6); v.emplace_back(7);
    std::cout << "\n20: "; d.insert(d.begin() + 1, v.begin(), v.end());
    std::cout << "\n21: "; d.insert(d.end() - 2, v.begin(), v.end());
    std::cout << "\n22: "; d.assign(v.begin(), v.end());
    std::cout << "\nend: ";
  }
  {
    std::cout << "\n[list]";
    std::list<A> d;
    for (int i = 0; i < 6; i++) d.emplace_back(i);
    std::cout << "\n1: "; d.insert(std::next(d.begin(), 2), x);
    std::cout << "\n2: "; d.insert(std::next(d.begin(), 1), 2, x);
    std::cout << "\n3: "; d.emplace(std::next(d.begin(), 1), 7);
    std::cout << "\n4: "; d.erase(std::next(d.begin(), 1), std::next(d.begin(), 4));
    std::cout << "\n5: "; d.resize(3, x);
    std::cout << "\n6: "; d.resize(5, x);
    std::cout << "\n7: "; d.assign(3, x);
    std::cout << "\n8: "; std::list<A> e; e.emplace_back(1); e.emplace_back(2); e.emplace_back(3); e.emplace_back(4); d = e;
    std::cout << "\n9: "; d.pop_front(); d.insert(d.end(), e.begin(), e.end());
    std::cout << "\n10: "; d.clear();
    std::cout << "\nend: ";
  }
  std::cout << "\n";
}
