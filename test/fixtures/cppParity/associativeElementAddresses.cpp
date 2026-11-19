#include <iostream>
#include <map>
#include <set>
#include <unordered_map>
#include <unordered_set>

int main() {
  std::set<int> ordered{3, 7};
  const int* first = &*ordered.begin();
  const int* end = first + 1;
  ordered.insert(1);
  std::cout << *(end - 1) << ' ' << end - first << '\n';

  std::unordered_set<int> hashed{4, 8};
  const int* found = &*hashed.find(4);
  end = found + 1;
  hashed.rehash(40);
  std::cout << *(end - 1) << ' ' << (found == &*hashed.find(4)) << '\n';

  std::map<int, int> tree{{5, 6}};
  auto entry = tree.begin();
  auto* pair = &*entry;
  std::map<int, int> other;
  tree.swap(other);
  std::cout << (static_cast<const void*>(pair) == static_cast<const void*>(&entry->first)) << ' '
            << (pair == &*other.begin()) << ' ' << ((pair + 1) - 1)->second << '\n';

  std::unordered_map<int, int> table{{9, 2}};
  pair = &*table.begin();
  table.rehash(40);
  std::cout << (static_cast<const void*>(pair) == static_cast<const void*>(&pair->first)) << ' '
            << (pair == &*table.find(9)) << ' ' << ((pair + 1) - 1)->second << '\n';
}
