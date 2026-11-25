#include <iostream>
#include <set>
#include <map>
#include <queue>
#include <vector>
#include <string>
struct ByLen { bool operator()(const std::string& a, const std::string& b) const { return a.size() < b.size(); } };
struct Desc { bool operator()(int a, int b) const { return a > b; } };
int main() {
  auto cmp = [](int a, int b) { return a > b; };
  std::set<int, decltype(cmp)> s(cmp);
  for (int x : {3, 1, 4, 1, 5}) s.insert(x);
  for (int x : s) std::cout << x;
  std::cout << "\n";
  std::map<std::string, int, ByLen> m;
  m["ccc"] = 3; m["a"] = 1; m["bb"] = 2; m["dd"] = 9;
  for (auto& kv : m) std::cout << kv.first << kv.second << " ";
  std::cout << "\n";
  std::priority_queue<int, std::vector<int>, Desc> pq;
  for (int x : {5, 2, 8}) pq.push(x);
  while (!pq.empty()) { std::cout << pq.top(); pq.pop(); }
  std::cout << "\n";
  std::priority_queue<int, std::vector<int>, decltype(cmp)> pq2(cmp);
  pq2.push(3); pq2.push(1);
  std::cout << pq2.top() << "\n";
}
