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

  std::vector<std::vector<Item>> positioned;
  positioned.emplace(positioned.end(), 2);
  positioned.reserve(8);
  positioned.emplace(positioned.begin(), 3);
  positioned.push_back(std::vector<Item>(4));
  positioned.insert(positioned.begin() + 1, std::vector<Item>(5));
  positioned.erase(positioned.begin());
  std::cout << positioned[0].size() << positioned[1].size() << positioned[2].size() << '\n';

  std::deque<std::vector<Item>> deque;
  deque.push_back(std::vector<Item>(1));
  deque.push_front(std::vector<Item>(2));
  deque.emplace(deque.begin() + 1, 3);
  deque.insert(deque.begin() + 1, std::vector<Item>(4));
  std::cout << deque[0].size() << deque[1].size() << deque[2].size() << deque[3].size() << '\n';

  std::list<std::vector<Item>> list;
  list.push_front(std::vector<Item>(5));
  list.insert(list.end(), std::vector<Item>(6));
  std::cout << list.front().size() << list.back().size() << '\n';
}
