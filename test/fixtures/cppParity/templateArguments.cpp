#include <iostream>
#include <queue>
#include <vector>
#include <map>
#include <string>
#include <limits>
#include <utility>
#include <functional>
int main() {
  std::priority_queue<std::pair<int,int>, std::vector<std::pair<int,int>>, std::greater<std::pair<int,int>>> q;
  q.push({3, 1}); q.push({1, 2}); q.push({2, 0});
  while (!q.empty()) { std::cout << q.top().first << q.top().second << " "; q.pop(); }
  std::map<std::string, std::vector<std::pair<int,int>>> g; g["a"].push_back({1, 2});
  std::vector<std::vector<std::pair<int,char>>> vv(2); vv[1].push_back(std::make_pair(5, 'x'));
  std::string s = "abc";
  std::cout << (s.find('z') == std::string::npos) << " " << std::numeric_limits<int>::max() << " " << std::numeric_limits<long long>::min()
            << " " << g["a"][0].second << vv[1][0].second << std::endl;
  std::string::size_type n = s.size(); std::cout << n << std::endl;
}
