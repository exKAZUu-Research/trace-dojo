#include <iostream>
#include <vector>
class List {
 public:
  struct Node {
    int value;
    Node* next;
  };
  class Iterator;
  void push(int v) { head = new Node{v, head}; ++count; }
  int size() const { return count; }
  Iterator begin() const;
  ~List() { while (head) { Node* n = head->next; delete head; head = n; } }
 private:
  Node* head = nullptr;
  int count = 0;
  static constexpr int LIMIT = 10;
};
class List::Iterator {
 public:
  explicit Iterator(List::Node* n) : node(n) {}
  int operator*() const { return node->value; }
  bool done() const { return node == nullptr; }
  void next() { node = node->next; }
  int limit() const { return LIMIT; }
 private:
  List::Node* node;
};
List::Iterator List::begin() const { return Iterator(head); }
struct Outer {
  enum class Mode { A, B };
  struct Inner { Mode m = Mode::B; int twice(int x) const { return x * 2; } };
  Inner in;
};
int main() {
  List l;
  l.push(1); l.push(2); l.push(3);
  for (List::Iterator it = l.begin(); !it.done(); it.next()) std::cout << *it;
  std::cout << " " << l.size() << " " << l.begin().limit() << "\n";
  Outer o;
  std::cout << (o.in.m == Outer::Mode::B) << o.in.twice(4) << "\n";
  struct Local {
    int a, b;
    int sum() const { return a + b; }
  };
  Local x{3, 4};
  std::vector<Local> v = {{1, 2}, {5, 6}};
  std::cout << x.sum() << v[1].sum() << sizeof(Local) << "\n";
  typedef int Num;
  struct Doubler { Num twice(Num n) { return n * 2; } };
  std::cout << Doubler().twice(21) << "\n";
}
