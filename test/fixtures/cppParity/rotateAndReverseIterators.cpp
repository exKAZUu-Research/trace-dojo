#include <algorithm>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <iterator>
#include <list>
#include <string>

struct Item {
  int id;
  Item(int value) : id(value) {}
  Item(const Item& other) : id(other.id) { std::cout << 'C' << id; }
  ~Item() { std::cout << 'D' << id; }
};

struct Named {
  std::string name;
  Named(const char* value) : name(value) {}
  Named(const Named& other) : name(other.name) { std::cout << 'C' << name; }
  ~Named() { std::cout << 'D' << name; }
};

bool loggingLess(int left, int right) {
  std::cout << left << ',' << right << ';';
  return left < right;
}

int main() {
  {
    Item items[] = {1, 2, 3, 4, 5};
    auto middle = std::rotate(items, items + 2, items + 5);
    std::cout << '|' << middle->id << '|';
    std::rotate(items, items + 1, items + 5);
    std::cout << '|';
    std::rotate(items, items + 4, items + 5);
    std::cout << '|';
    std::swap(items[0], items[0]);
    std::iter_swap(items + 1, items + 1);
    std::cout << '|';
    for (const auto& item : items) std::cout << item.id;
    std::cout << '|';
  }
  std::cout << '\n';
  {
    std::list<Named> items;
    items.emplace_back("a");
    items.emplace_back("b");
    items.emplace_back("c");
    items.emplace_back("d");
    auto middle = std::rotate(items.begin(), std::next(items.begin(), 1), items.end());
    std::cout << '|' << middle->name << '|';
    for (const auto& item : items) std::cout << item.name;
    std::cout << '|';
  }
  std::cout << '\n';
  int values[] = {1, 2, 3};
  const int constant[] = {4, 5};
  *std::rbegin(values) = 7;
  for (auto it = std::rbegin(values); it != std::rend(values); ++it) std::cout << *it;
  std::cout << '|' << *std::rbegin(constant) << '\n';
  std::cout << std::distance(values + 3, values) << ' '
            << std::distance(std::rbegin(values), std::rend(values)) << '\n';
  const auto& view = values;
  std::cout << (std::rbegin(values) == std::rbegin(view)) << ' ' << (std::rend(values) - std::rend(view)) << '\n';
  std::cout << std::clamp(5, 0, 10, loggingLess) << ' ' << std::clamp(-1, 0, 10, loggingLess) << '\n';
  char bytes[8] = "a";
  std::strncpy(bytes + 2, bytes, 4);
  std::puts(bytes + 2);
}
