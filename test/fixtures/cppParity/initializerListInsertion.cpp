#include <iostream>
#include <map>
#include <set>
#include <unordered_map>
#include <vector>

int main() {
  std::set<int> set;
  set.insert({3, 2, 1, 2});
  for (int n : set) std::cout << n;
  std::map<int, int> map;
  map.insert({{3, 4}, {1, 2}});
  map.insert({5, 6});
  for (const auto& pair : map) std::cout << ' ' << pair.first << pair.second;
  std::unordered_map<int, int> hash;
  hash.reserve(32);
  hash.insert({{3, 4}, {1, 2}});
  auto at = hash.find(3);
  hash[7] = 9;
  hash.erase(hash.find(1));
  auto result = hash.insert({7, 10});
  std::cout << ' ' << at->second << ' ' << result.first->second << result.second;
  std::vector<int> vector;
  vector.insert(vector.end(), {3});
  vector.insert(vector.begin(), {1, 2});
  for (int n : vector) std::cout << n;
}
