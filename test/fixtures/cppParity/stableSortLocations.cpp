#include <algorithm>
#include <iostream>
#include <string>
#include <vector>

const int* first = nullptr;
const int* second = nullptr;

bool observesElements(const int& left, const int& right) {
  std::cout << (&left == second) << (&right == first);
  return left < right;
}

int originalOperands = 0;
int comparisons = 0;

bool countOperands(const int& left, const int& right) {
  ++comparisons;
  if (&left == first || &left == second) ++originalOperands;
  if (&right == first || &right == second) ++originalOperands;
  return left < right;
}

struct Item {
  std::string label;
  int rank;
  Item(std::string name, int value) : label(name), rank(value) {}
  Item(const Item& source) : label(source.label), rank(source.rank) { std::cout << 'C' << label; }
  ~Item() { std::cout << 'D' << label; }
};

bool fail = false;
bool byRank(const Item& left, const Item& right) {
  if (fail && left.rank == 0) throw 1;
  return left.rank < right.rank;
}

struct Number {
  int value;
  Number(int input) : value(input) {}
  Number(const Number& input) : value(input.value) { std::cout << 'C' << value; }
  ~Number() { std::cout << 'D' << value; }
};

bool byValue(const Number& left, const Number& right) { return left.value < right.value; }

void sortNumbers() {
  Number numbers[] = {2, 3, 4, 1};
  std::stable_sort(numbers, numbers + 4, byValue);
  for (const Number& number : numbers) std::cout << number.value;
  std::cout << ' ';
}

void sortItems(bool shouldFail) {
  Item items[] = {{"a", 2}, {"b", 1}, {"c", 1}, {"d", 0}};
  fail = shouldFail;
  try {
    std::stable_sort(items, items + 4, byRank);
  } catch (int) {
    std::cout << 'E';
  }
  for (const Item& item : items) std::cout << item.label;
  std::cout << ' ';
}

int main() {
  int numbers[]{2, 1};
  first = &numbers[0];
  second = &numbers[1];
  std::stable_sort(numbers, numbers + 2, observesElements);
  std::cout << ':' << numbers[0] << numbers[1] << ' ';

  std::vector<int> small{2, 1};
  first = &small[0];
  second = &small[1];
  std::stable_sort(small.begin(), small.end(), observesElements);
  std::cout << ':' << small[0] << small[1] << '\n';

  std::vector<int> large(129);
  for (int i = 0; i < 129; ++i) large[i] = (129 - i) % 5;
  first = &large[0];
  second = &large[1];
  std::stable_sort(large.begin(), large.end(), countOperands);
  std::cout << originalOperands << ' ' << comparisons << ' ' << large.front() << large.back() << '\n';

  sortNumbers();
  std::cout << '\n';
  sortItems(false);
  std::cout << '\n';
  sortItems(true);
  std::cout << '\n';
}
