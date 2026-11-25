#include <iostream>
#include <vector>
#include <string>
#include <map>
template <class T>
class Stack {
  std::vector<T> items;
 public:
  void push(const T& x) { items.push_back(x); }
  T pop() { T x = items.back(); items.pop_back(); return x; }
  bool empty() const { return items.empty(); }
  std::size_t size() const { return items.size(); }
  template <class F> void forEach(F f) const { for (const T& x : items) f(x); }
  template <class U> Stack<U> map(U (*fn)(T)) const { Stack<U> out; for (const T& x : items) out.push(fn(x)); return out; }
};
template <class T> std::ostream& operator<<(std::ostream& os, const Stack<T>& s) { return os << "Stack(" << s.size() << ")"; }
template <class K, class V>
struct Cache {
  std::map<K, V> data;
  V get(const K& k, V fallback) const { auto it = data.find(k); return it == data.end() ? fallback : it->second; }
};
struct Counter { template <class T> static int count(const std::vector<T>& v) { return static_cast<int>(v.size()); } };
template <class T> T sumAll(const std::vector<T>& v) { T total{}; for (const T& x : v) total += x; return total; }
std::string label(int x) { return "#" + std::to_string(x); }
template <class T> struct Node { T value; Node* next; };
template <class T> int lengthOf(Node<T>* n) { int c = 0; while (n) { ++c; n = n->next; } return c; }
int main() {
  Stack<int> s;
  s.push(1); s.push(2); s.push(3);
  std::cout << s << " " << s.pop() << "\n";
  int total = 0;
  s.forEach([&](int x) { total += x; });
  std::cout << total << "\n";
  Stack<std::string> labels = s.map(label);
  std::cout << labels.pop() << labels.size() << "\n";
  Cache<std::string, int> c;
  c.data["a"] = 1;
  std::cout << c.get("a", -1) << c.get("b", -1) << "\n";
  std::cout << Counter::count(std::vector<double>{1.0, 2.0}) << " " << sumAll(std::vector<double>{1.5, 2.5}) << " " << sumAll(std::vector<std::string>{"a", "b"}) << "\n";
  Node<int> n3{3, nullptr}, n2{2, &n3}, n1{1, &n2};
  std::cout << lengthOf(&n1) << "\n";
}
