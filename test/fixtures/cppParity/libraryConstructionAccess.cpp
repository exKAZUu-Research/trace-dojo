#include <array>
#include <iostream>
#include <vector>

class Item {
public:
  static int make() {
    std::vector<Item> values;
    values.push_back(Item());
    std::array<Item, 0> empty;
    std::array<Item, 1> aggregate{};
    return values.size() + empty.size() + aggregate.size();
  }

private:
  Item() {}
};

int main() { std::cout << Item::make() << '\n'; }
