#include <algorithm>
#include <deque>
#include <functional>
#include <iostream>
#include <queue>
#include <stack>
#include <unordered_map>
#include <vector>

int copies;
struct Item {
  int n;
  Item(int value) : n(value) {}
  Item(const Item& other) : n(other.n) {
    std::cout << 'C';
    if (++copies == 2) throw 1;
  }
  ~Item() { std::cout << n; }
};
bool isLess(const Item& a, const Item& b) { return a.n < b.n; }

int main() {
  try { std::minmax({Item(2), Item(1)}, isLess); }
  catch (int) { std::cout << 'X' << ' '; }
  std::deque<int> numbers{4, 1, 8};
  std::stack<int> stack(numbers), other(numbers);
  std::queue<int> queue(numbers);
  std::vector<int> vec{2, 8, 5};
  std::priority_queue<int> largest(vec.begin(), vec.end());
  std::priority_queue<int, std::vector<int>, std::greater<int>> smallest(std::greater<int>(), vec);
  std::unordered_map<int, int> a{{1, 5}, {2, 8}}, b{{2, 8}, {1, 5}};
  std::cout << (stack == other) << queue.front() << largest.top() << smallest.top() << (a == b);
  b[1] = 9;
  std::cout << (a != b);
}
