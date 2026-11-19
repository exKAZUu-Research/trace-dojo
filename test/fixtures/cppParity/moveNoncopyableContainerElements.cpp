#include <algorithm>
#include <deque>
#include <iostream>
#include <iterator>
#include <list>
#include <map>
#include <queue>
#include <stack>
#include <unordered_map>
#include <utility>
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
struct DerivedWrapper : Wrapper {
  DerivedWrapper(int n) : Wrapper{std::vector<Item>(n)} {}
};
Wrapper slicedResult() { return DerivedWrapper(4); }
bool smaller(const Wrapper& a, const Wrapper& b) { return a.items.size() < b.items.size(); }
bool hasOne(const Wrapper& a) { return a.items.size() == 1; }
bool sameSize(const Wrapper& a, const Wrapper& b) { return a.items.size() == b.items.size(); }
Wrapper sized(int length) { return Wrapper{std::vector<Item>(length)}; }
Wrapper combined(int left, int right) { return sized(left + right); }

struct Component {
  Component() {}
  Component(const Component&) {}
};
struct WithCopyingMember { std::vector<Item> items; Component component; };

struct Box {
  std::vector<Item> items;
  Box(int n) : items(n) {}
};
struct Two {
  std::vector<Item> items;
  Two(int a, int b) : items(a + b) {}
};

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

  positioned.push_back({});
  deque.push_front({});
  std::cout << positioned.back().size() << deque.front().size() << '\n';

  std::vector<Box> boxes;
  boxes.push_back(2);
  boxes.push_back({3});
  boxes.insert(boxes.begin(), 4);
  std::cout << boxes[0].items.size() << boxes[1].items.size() << boxes[2].items.size() << '\n';
  std::vector<Two> two;
  two.insert(two.end(), {2, 3});
  std::cout << two.front().items.size() << '\n';

  WithCopyingMember first{std::vector<Item>(2)}, second{std::vector<Item>(3)};
  std::swap(first, second);
  std::cout << first.items.size() << second.items.size() << '\n';
  Wrapper sorted[] = {{std::vector<Item>(5)}, {std::vector<Item>(1)}, {std::vector<Item>(2)}};
  std::iter_swap(sorted, sorted + 2);
  std::cout << sorted[0].items.size() << sorted[2].items.size() << '\n';
  std::sort(sorted, sorted + 3, smaller);
  std::cout << sorted[0].items.size() << sorted[1].items.size() << sorted[2].items.size() << '\n';

  std::stack<Wrapper, std::vector<Wrapper>> stack;
  stack.push(Wrapper{std::vector<Item>(2)});
  stack.push({std::vector<Item>(3)});
  std::queue<Box> queue;
  queue.push(4);
  queue.push({5});
  std::cout << stack.top().items.size() << queue.front().items.size() << queue.back().items.size() << '\n';

  std::priority_queue<std::vector<int>> priority;
  priority.push(std::vector<int>{2, 7});
  priority.push({3, 1});
  std::cout << priority.top()[0];
  priority.pop();
  std::cout << priority.top()[0] << '\n';

  std::map<int, std::vector<Item>> map;
  map.emplace(1, std::vector<Item>(2));
  map.try_emplace(2, std::vector<Item>(3));
  map.try_emplace(2, std::vector<Item>(9));
  std::unordered_map<int, std::vector<Item>> unordered;
  unordered.emplace(1, std::vector<Item>(4));
  unordered.try_emplace(2, std::vector<Item>(5));
  std::cout << map[1].size() << map[2].size() << unordered[1].size() << unordered[2].size() << '\n';

  std::pair<std::vector<Item>, int> pair(std::vector<Item>(2), 3);
  auto made = std::make_pair(std::vector<Item>(4), 5);
  std::pair<std::vector<Item>, long> converted(std::make_pair(std::vector<Item>(6), 7));
  std::cout << pair.first.size() << pair.second << made.first.size() << made.second
            << converted.first.size() << converted.second << '\n';

  Wrapper assigned{std::vector<Item>(2)};
  assigned = Wrapper{std::vector<Item>(3)};
  std::cout << assigned.items.size() << '\n';
  Wrapper sliced = DerivedWrapper(3);
  std::cout << sliced.items.size() << ' ' << slicedResult().items.size() << '\n';

  Wrapper removable[] = {{std::vector<Item>(1)}, {std::vector<Item>(2)}, {std::vector<Item>(3)}};
  auto removed = std::remove_if(removable, removable + 3, hasOne);
  std::cout << (removed - removable) << ' ' << removable[0].items.size()
            << ' ' << removable[1].items.size() << '\n';
  Wrapper duplicate[] = {{std::vector<Item>(1)}, {std::vector<Item>(1)}, {std::vector<Item>(2)}};
  auto distinct = std::unique(duplicate, duplicate + 3, sameSize);
  std::cout << (distinct - duplicate) << ' ' << duplicate[0].items.size()
            << ' ' << duplicate[1].items.size() << '\n';

  int lengths[] = {1, 2};
  Wrapper output[2];
  output[0] = sized(10);
  std::transform(lengths, lengths + 2, output, sized);
  std::cout << output[0].items.size() << ' ' << output[0].items.capacity() << '\n';
  output[0] = sized(10);
  std::transform(lengths, lengths + 2, lengths, output, combined);
  std::cout << output[0].items.size() << ' ' << output[0].items.capacity() << '\n';
  std::vector<Wrapper> appended;
  std::transform(lengths, lengths + 2, std::back_inserter(appended), sized);
  std::cout << appended[0].items.size() << ' ' << appended[1].items.size() << '\n';
}
