#include <iostream>
#include <list>

struct Item;
std::list<Item>* current = nullptr;

struct Item {
  int value;
  Item(int number = 0) : value(number) {}
  ~Item();
};

Item::~Item() {
  std::cout << value << ':' << current->size() << ':' << current->empty() << '[';
  for (const Item& item : *current) std::cout << item.value;
  std::cout << ']';
}

int main() {
  std::list<Item> items;
  current = &items;
  for (int number = 1; number <= 4; ++number) items.emplace_back(number);
  auto first = items.begin();
  ++first;
  auto last = first;
  ++last;
  ++last;
  auto next = items.erase(first, last);
  std::cout << '=' << next->value << '|';
  items.clear();
  std::cout << '\n';

  for (int number = 1; number <= 4; ++number) items.emplace_back(number);
  items.resize(2);
  std::cout << '|';
  items.erase(items.begin(), items.end());
  std::cout << '\n';
}
