#include <iostream>
#include <deque>
#include <list>
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

int nextId = 0;
int failId = 3;
struct Node {
  int id;
  Node() : id(++nextId) {
    if (id == failId) throw 1;
  }
  Node(const Node& source) : id(source.id) {
    if (id == failId) throw 1;
  }
  ~Node() { std::cout << id; }
};

struct ListValue {
  int number;
  ListValue(int n) : number(n) {}
  ListValue(const ListValue& other, int offset = 0) : number(other.number + offset) {
    std::cout << 'C' << number;
    if (number == 2) throw number;
  }
  ~ListValue() { std::cout << 'D' << number; }
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
  try { std::list<Node> nodes(3); } catch (int) { std::cout << 'L'; }
  nextId = 0;
  failId = 0;
  std::list<Node> original(3);
  failId = 3;
  try { auto copy = original; } catch (int) { std::cout << 'L'; }
  try { std::deque<ListValue> values{ListValue(1), ListValue(2)}; } catch (int) { std::cout << 'Q'; }
  try { std::vector<ListValue> values{ListValue(1), ListValue(2)}; } catch (int) { std::cout << 'V'; }
  std::cout << '\n';

  nextId = 0;
  failId = 2;
  try { std::deque<Node> values(3); } catch (int) { std::cout << 'N'; }
  failOn = copies + 2;
  try { std::deque<Value> values(3, v[0]); } catch (int) { std::cout << 'F'; }
  ListValue elements[] = {ListValue(1), ListValue(2), ListValue(3)};
  try { std::deque<ListValue> values(elements, elements + 3); } catch (int) { std::cout << 'R'; }
  failOn = 0;
  std::deque<Value> entries(3, v[0]);
  failOn = copies + 2;
  try { std::deque<Value> values(entries); } catch (int) { std::cout << 'C'; }
  nextId = 0;
  std::deque<Node> edited;
  try { edited.resize(3); } catch (int) { std::cout << 'E' << edited.size(); }
}
