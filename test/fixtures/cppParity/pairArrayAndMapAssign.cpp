#include <iostream>
#include <map>
#include <utility>

struct Cell {
  int value;
  Cell() : value(2) { std::cout << 'C'; }
  Cell(const Cell& source) : value(source.value) { std::cout << 'P'; }
  ~Cell() { std::cout << 'D' << value; }
};

class Item {
  Item(const Item&);
public:
  int value;
  Item(int number) : value(number) { std::cout << 'I' << value; }
  ~Item() { std::cout << 'J' << value; }
};

int main() {
  std::pair<int[2][2], int> zeros;
  std::cout << zeros.first[1][1] << '\n';
  {
    std::pair<Cell[2], int> original;
    original.first[1].value = 4;
    auto copy = original;
    original.first[1].value = 6;
    std::cout << copy.first[1].value << ' ';
  }
  std::cout << '\n';
  std::map<int, Item> entries;
  auto inserted = entries.insert_or_assign(3, 7);
  std::cout << ' ' << inserted.second << ' ';
  auto updated = entries.insert_or_assign(3, 8);
  std::cout << ' ' << updated.second << ' ' << updated.first->second.value << '\n';
}
