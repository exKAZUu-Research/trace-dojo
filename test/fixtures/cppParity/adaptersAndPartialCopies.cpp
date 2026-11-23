#include <algorithm>
#include <deque>
#include <functional>
#include <iostream>
#include <queue>
#include <random>
#include <stack>
#include <list>
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

struct RandomMember { char prefix; std::random_device generator; };

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
  int& stacked = stack.emplace(4);
  int& queued = queue.emplace(5);
  stacked += 3;
  queued += 3;
  std::stack<bool, std::vector<bool>> bits;
  auto bit = bits.emplace(false);
  bit = true;
  largest.emplace(9);
  std::cout << stack.top() << queue.back() << static_cast<bool>(bits.top()) << largest.top();
  std::cout << ' ' << sizeof(std::stack<int, std::vector<int>>)
            << ' ' << sizeof(std::stack<int, std::list<int>>)
            << ' ' << sizeof(std::priority_queue<int, std::deque<int>>) << ' ' << sizeof(RandomMember);
  std::vector<std::pair<int, int>> storage{{1, 10}, {2, 20}, {3, 30}};
  std::priority_queue<std::pair<int, int>> heap(std::less<std::pair<int, int>>(), storage);
  const int* top = &heap.top().second;
  heap.pop();
  std::cout << ' ' << *top;
  heap.push({4, 40});
  std::cout << ' ' << *top;
  b[1] = 9;
  std::cout << (a != b);
}
