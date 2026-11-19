#include <iostream>
#include <stack>
#include <vector>

int copies = 0;
int failOn = 0;
struct Value {
  int n = 0;
  Value() { std::cout << 'N'; }
  Value(const Value& other) : n(other.n) {
    std::cout << 'C';
    if (++copies == failOn) throw 1;
  }
  ~Value() { std::cout << 'D'; }
};

int main() {
  std::vector<Value> v(2);
  v[0].n = 7;
  failOn = 2;
  try { v.reserve(5); } catch (int) { std::cout << 'R'; }
  std::cout << v.size() << v.capacity() << v[0].n;
  failOn = copies + 2;
  try { std::vector<Value> w(v); } catch (int) { std::cout << 'V'; }
  std::stack<Value, std::vector<Value>> s(v);
  failOn = copies + 2;
  try { auto t = s; } catch (int) { std::cout << 'S'; }
}
