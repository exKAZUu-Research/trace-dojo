#include <iostream>
#include <vector>
#include <map>
#include <set>
#include <unordered_map>
#include <unordered_set>
#include <string>
#include <queue>
#include <stack>
#include <random>
#include <iomanip>
int main() {
  std::vector<int> v = {3, 1, 2};
  v.push_back(5);
  for (int x : v) std::cout << x << " ";
  std::cout << v.size() << " " << v.capacity() << "\n";
  std::map<std::string, int> m;
  m["b"] = 2; m["a"] = 1; m["c"]++;
  for (auto& p : m) std::cout << p.first << "=" << p.second << " ";
  std::cout << "\n";
  std::set<int> s = {5, 1, 3, 1};
  for (int x : s) std::cout << x;
  std::cout << "\n";
  std::unordered_set<int> us = {10, 3, 7, 1, 25, 4};
  for (int x : us) std::cout << x << " ";
  std::cout << "\n";
  std::unordered_map<std::string, int> um = {{"apple", 1}, {"banana", 2}, {"cherry", 3}, {"date", 4}, {"elderberry", 5}};
  for (auto& p : um) std::cout << p.first << " ";
  std::cout << "\n";
  std::priority_queue<int> pq; pq.push(3); pq.push(9); pq.push(1);
  while (!pq.empty()) { std::cout << pq.top(); pq.pop(); }
  std::cout << "\n";
  std::mt19937 gen(42);
  std::uniform_int_distribution<int> d(1, 6);
  for (int i = 0; i < 5; i++) std::cout << d(gen) << " ";
  std::uniform_real_distribution<double> r(0.0, 1.0);
  std::cout << std::fixed << std::setprecision(4) << r(gen) << " " << gen() << "\n";
  std::stack<int> st; st.push(1); st.push(2); std::cout << st.top() << "\n";
}
