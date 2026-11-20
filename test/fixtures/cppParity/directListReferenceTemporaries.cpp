#include <deque>
#include <iostream>
#include <list>
#include <random>
#include <vector>

class Item {
public:
  Item() {}

private:
  Item(const Item&);
};

const std::vector<Item>& fileScope{1};

int main() {
  const std::vector<Item>& vector{2};
  static const std::vector<Item>& blockStatic{3};
  const std::deque<Item>& deque{4};
  const std::list<Item>& list{5};
  const std::mt19937& seeded{6};
  std::mt19937 engine = seeded;
  std::cout << fileScope.size() << vector.size() << blockStatic.size() << deque.size() << list.size() << '\n';
  std::cout << engine() << '\n';
}
