#include <iostream>
#include <unordered_map>

int copies;
bool fail;
struct Item {
  int value;
  Item(int n) : value(n) {}
  Item(const Item& other) : value(other.value) {
    std::cout << 'C' << value;
    if (fail && ++copies == 2) throw 9;
  }
  ~Item() { std::cout << 'D' << value; }
};

void probe(bool reuse) {
  std::unordered_map<int, Item> source;
  source.try_emplace(1, 1);
  source.try_emplace(2, 2);
  source.try_emplace(3, 3);
  std::unordered_map<int, Item> target;
  if (reuse) target.try_emplace(4, 4);
  copies = 0;
  fail = true;
  try {
    target = source;
  } catch (int) {
    std::cout << " size=" << target.size();
    for (auto it = target.begin(); it != target.end(); ++it) std::cout << ' ' << it->first;
    std::cout << '|';
  }
}

int main() {
  probe(false);
  std::cout << '\n';
  probe(true);
  std::cout << '\n';
}
