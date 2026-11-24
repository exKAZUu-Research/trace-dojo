#include <algorithm>
#include <forward_list>
#include <iostream>
#include <numeric>
#include <string>
int main() {
  std::forward_list<int> fl{5, 2, 9, 1};
  fl.push_front(7);
  for (int x : fl) std::cout << x << " ";
  std::cout << "\n";
  auto it = fl.insert_after(fl.before_begin(), 100);
  fl.insert_after(it, {200, 300});
  fl.erase_after(fl.begin());
  for (int x : fl) std::cout << x << " ";
  std::cout << "\n";
  fl.sort();
  fl.reverse();
  fl.remove_if([](int n) { return n > 100; });
  fl.remove(1);
  for (int x : fl) std::cout << x << " ";
  std::cout << std::distance(fl.begin(), fl.end()) << " " << std::accumulate(fl.begin(), fl.end(), 0) << " "
            << *std::max_element(fl.begin(), fl.end()) << " " << (std::find(fl.begin(), fl.end(), 9) != fl.end()) << "\n";
  std::forward_list<std::string> words{"b", "a", "c"};
  std::forward_list<std::string> more{"d", "a"};
  words.sort();
  more.sort();
  words.merge(more);
  words.unique();
  for (const auto& w : words) std::cout << w;
  std::cout << " " << words.empty() << more.empty() << words.front() << "\n";
  auto prev = words.before_begin();
  for (auto cur = words.begin(); cur != words.end(); prev = cur, ++cur)
    if (*cur == "c") {
      words.erase_after(prev);
      break;
    }
  for (const auto& w : words) std::cout << w;
  std::cout << "\n";
  std::forward_list<int> a{1, 2}, b{1, 3};
  std::cout << (a < b) << (a == b) << "\n";
}
