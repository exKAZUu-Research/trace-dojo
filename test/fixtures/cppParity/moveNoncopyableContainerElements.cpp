#include <deque>
#include <iostream>
#include <list>
#include <vector>

class Item {
public:
  Item() {}

private:
  Item(const Item&);
};

std::vector<Item> vectorResult(std::vector<Item> values) { return values; }
std::deque<Item> dequeResult(std::deque<Item> values) { return values; }
std::list<Item> listResult(std::list<Item> values) { return values; }

struct Wrapper { std::vector<Item> items; };
Wrapper wrappedResult(Wrapper value) { return value; }

int main() {
  auto v = vectorResult(std::vector<Item>(2));
  auto d = dequeResult(std::deque<Item>(3));
  auto l = listResult(std::list<Item>(4));
  auto w = wrappedResult(Wrapper{std::vector<Item>(5)});
  std::cout << v.size() << d.size() << l.size() << w.items.size() << '\n';

  std::vector<std::vector<Item>> nested;
  nested.emplace_back(2);
  nested.emplace_back(3);
  nested.reserve(8);
  nested.resize(4);
  nested.shrink_to_fit();
  std::cout << nested[0].size() << nested[1].size() << nested[2].size() << nested.size() << '\n';
}
