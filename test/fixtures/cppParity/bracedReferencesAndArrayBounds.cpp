#include <iostream>
#include <new>
#include <queue>
#include <stack>
#include <string>
#include <utility>
#include <vector>

struct Reference { const int& value; };
struct Position { int first; int second; };
const Position& global = {5, 6};
int shared = 5;
struct Alias { int& value{shared}; };
struct RefMember { int& value; };
struct Print {
  Print() { std::cout << 'C'; }
  ~Print() { std::cout << 'D'; }
};
struct ObjectReference { const Print& value; };
Print make() { return Print{}; }
std::stack<int> makeStack() { return std::stack<int>({1, 2}); }

int main() {
  int n = 2;
  Reference local({n});
  auto heap = new Reference({n});
  n = 3;
  std::cout << local.value << heap->value;
  delete heap;
  int tooSmall = 1;
  try { auto p = new int[tooSmall]{1, 2}; delete[] p; }
  catch (const std::bad_array_new_length&) { std::cout << 'L'; }
  catch (const std::bad_alloc&) { std::cout << 'A'; }
  int negative = -1;
  try { auto p = new int[negative]; delete[] p; }
  catch (const std::bad_alloc&) { std::cout << 'A'; }
  ObjectReference byValue({Print{}});
  std::cout << 'X';
  ObjectReference byCall({make()});
  std::cout << 'X';
  Position position{3, 4};
  int* end = &position.first + 1;
  std::cout << *(end - 1);
  std::stack<int> s({1, 2});
  auto t = makeStack();
  std::queue<int> q({5, 6});
  std::cout << s.top() << t.top() << q.back() << q.front();
  std::pair<int, int> direct{1, 2.5};
  std::pair<int, int> copy = {1, 2.5};
  auto cast = std::pair<int, long>({1, 3.5});
  std::cout << direct.second << copy.second << cast.second;
  const std::vector<int>& list = {1, 2, 3};
  const std::vector<int>& single = {7};
  const std::string& empty = {};
  const int& zero = {};
  static const Position& pair = {8, 9};
  int& alias = {n};
  ++alias;
  std::cout << list.size() << single[0] << empty.size() << zero << global.first << pair.second << n;
  Alias defaultMember;
  RefMember nested{{n}};
  ++defaultMember.value;
  ++nested.value;
  std::cout << shared << n;
}
