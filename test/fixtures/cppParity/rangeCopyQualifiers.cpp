#include <array>
#include <deque>
#include <iostream>
#include <list>
#include <vector>

struct Choice {
  Choice() {}
  Choice(Choice&) { std::cout << 'M'; }
  Choice(const Choice&) { std::cout << 'C'; }
};

struct MutableOnly {
  MutableOnly() {}
  MutableOnly(MutableOnly&) { std::cout << 'L'; }
};

struct NestedArray {
  std::array<std::array<MutableOnly, 1>, 1> cells;
};

int main() {
  Choice mutableItems[2];
  const Choice constItems[2];
  std::vector<Choice> fromMutable(mutableItems, mutableItems + 2);
  std::vector<Choice> fromConst(constItems, constItems + 2);
  std::cout << '\n';

  MutableOnly source[1];
  std::vector<MutableOnly> mutableCopy(source, source + 1);
  std::cout << mutableCopy.size() << '\n';

  std::list<Choice> nodes(2);
  std::vector<Choice> assigned;
  assigned.assign(nodes.begin(), nodes.end());
  std::deque<Choice> inserted;
  inserted.insert(inserted.end(), nodes.cbegin(), nodes.cend());
  std::cout << '\n';

  NestedArray nested;
  NestedArray copied = nested;
  auto cells = copied.cells;
  std::array<Choice, 1> choices;
  auto selected = choices;
  std::array<MutableOnly, 0> empty;
  const auto constEmpty = empty;
  auto copiedEmpty = constEmpty;
  std::cout << cells.size() << selected.size() << copiedEmpty.size() << '\n';
}
