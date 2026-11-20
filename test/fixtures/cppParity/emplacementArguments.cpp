#include <deque>
#include <iostream>
#include <vector>

int removeLast(std::vector<int>& values, int value) {
  std::cout << 'p';
  values.pop_back();
  return value;
}

struct Token {
  int number;
  Token(int value) : number(value) { std::cout << 'T'; }
  ~Token() { std::cout << 't'; }
};

struct Item {
  int number;
  Item(const Token& token, int extra) : number(token.number + extra) { std::cout << 'I'; }
};

int main() {
  std::vector<int> values{1, 2};
  int* first = &values[0];
  values.emplace_back(removeLast(values, 3));
  std::cout << '|' << *first << ' ' << values.capacity() << '|';
  auto inserted = values.emplace(values.begin(), removeLast(values, 4));
  std::cout << *inserted << ' ' << values.size() << ' ' << values.capacity() << '\n';
  std::deque<Item> items;
  items.emplace_front(Token(5), 2);
  items.emplace_back(Token(6), 3);
  std::cout << '|' << items.front().number << ' ' << items.back().number << '\n';
}
