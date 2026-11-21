#include <iostream>
#include <iterator>
#include <map>
#include <set>
#include <utility>

int main() {
  std::multimap<int, int> entries{{0, 0}, {1, 10}, {1, 20}, {2, 99}};
  auto first = entries.insert(std::next(entries.begin()), {1, 5});
  auto middle = entries.emplace_hint(std::next(first), 1, 6);
  auto early = entries.insert(entries.begin(), std::pair<int, int>{1, 7});
  auto late = entries.insert(entries.end(), {1, 8});
  std::cout << first->second << middle->second << early->second << late->second << '\n';
  entries.emplace(1, 9);
  for (const auto& entry : entries) std::cout << entry.second << ' ';
  std::cout << '\n';

  std::map<int, int> unique{{1, 10}};
  auto existing = unique.emplace_hint(unique.end(), 1, 20);
  auto inserted = unique.insert(unique.begin(), std::pair<int, int>{2, 30});
  std::cout << existing->second << ' ' << inserted->second << '\n';

  std::multiset<int> duplicates{1, 1};
  auto hint = duplicates.insert(duplicates.begin(), 1);
  std::cout << std::distance(duplicates.begin(), hint) << '\n';
}
