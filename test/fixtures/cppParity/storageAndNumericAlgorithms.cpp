#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <list>
#include <numeric>
#include <stack>
#include <vector>

struct Value {
  int n;
  Value(int x) : n(x) {}
  Value(const Value& x) : n(x.n) { std::cout << 'C'; }
  ~Value() { std::cout << 'D'; }
};
bool less(const Value& a, const Value& b) { return a.n < b.n; }
int count = 1;
int next() {
  static auto& ref = count;
  static const int& offset = count + 1;
  return ++ref + offset;
}

int main() {
  static std::array<int, 2> zero;
  std::array<int, 2> alsoZero{};
  std::size_t position = 1;
  std::uint32_t number = 7;
  std::cout << zero[position] << alsoZero[position] << number << ' ' << next() << next() << ' ';
  std::stack<int> dequeStack;
  dequeStack.push(1);
  int& dequeItem = dequeStack.top();
  dequeStack.push(2);
  dequeStack.pop();
  std::stack<int, std::list<int>> listStack;
  listStack.push(3);
  int& listItem = listStack.top();
  listStack.push(4);
  listStack.pop();
  std::cout << dequeItem << listItem << ' ';
  int a[] = {1, 2};
  double b[] = {1.5, 2.5};
  std::cout << std::inner_product(a, a + 2, b, 0.0) << ' ';
  std::vector<int> valuesInReverse{1, 2, 3};
  std::cout << std::inner_product(valuesInReverse.begin(), valuesInReverse.end(), valuesInReverse.rbegin(), 0) << ' ';
  Value values[] = {6, 5, 4, 3, 2, 1};
  std::sort(values, values + 6, less);
  std::cout << '|';
}
