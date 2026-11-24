#include <iostream>
#include <vector>
#include <set>
#include <map>
#include <queue>
#include <algorithm>
#include <string>
struct P {
  int x, y;
  bool operator<(const P& o) const { return x != o.x ? x < o.x : y < o.y; }
  bool operator==(const P& o) const { return x == o.x && y == o.y; }
};
struct Task {
  int priority;
  std::string name;
};
bool operator<(const Task& a, const Task& b) { return a.priority < b.priority; }
int main() {
  std::vector<P> v = {{3, 1}, {1, 2}, {3, 0}, {2, 5}};
  std::sort(v.begin(), v.end());
  for (const P& p : v) std::cout << p.x << p.y << " ";
  std::cout << "\n";
  std::set<P> s(v.begin(), v.end());
  s.insert({1, 2});
  std::cout << s.size() << " " << s.begin()->y << "\n";
  std::map<P, std::string> m;
  m[{2, 2}] = "b";
  m[{1, 1}] = "a";
  for (auto it = m.begin(); it != m.end(); ++it) std::cout << it->second;
  std::cout << "\n";
  auto it = std::find(v.begin(), v.end(), P{2, 5});
  std::cout << (it - v.begin()) << " " << std::count(v.begin(), v.end(), P{3, 1}) << "\n";
  std::priority_queue<Task> q;
  q.push({2, "two"});
  q.push({5, "five"});
  q.push({1, "one"});
  while (!q.empty()) { std::cout << q.top().name << " "; q.pop(); }
  std::cout << "\n";
  P best = *std::max_element(v.begin(), v.end());
  std::cout << best.x << best.y << " " << std::min(P{1, 9}, P{1, 3}).y << "\n";
  std::cout << std::binary_search(v.begin(), v.end(), P{2, 5}) << "\n";
}
