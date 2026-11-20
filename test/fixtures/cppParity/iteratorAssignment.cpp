#include <algorithm>
#include <iostream>
#include <list>
#include <map>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>
struct Cursor { std::vector<int>::iterator at; int n; };
int main() {
  std::vector<int> v = {1, 2, 3};
  std::vector<int>::iterator it = v.begin() + 1; it = v.begin(); std::cout << *it;
  std::vector<int>::const_iterator ci = v.end(); ci = v.begin() + 2; std::cout << *ci;
  std::vector<int>::reverse_iterator ri = v.rbegin(); ri = v.rend() - 1; std::cout << *ri;
  std::string s = "abc"; std::string::iterator si = s.end() - 1; si = s.begin(); std::cout << *si;
  std::list<int> l = {4, 5}; std::list<int>::iterator li = l.end(); li = l.begin(); std::cout << *li;
  std::set<int> st = {7, 8}; std::set<int>::iterator ti = st.end(); ti = st.begin(); std::cout << *ti;
  std::map<int, char> m = {{1, 'x'}, {2, 'y'}}; std::map<int, char>::iterator mi = m.begin(); mi = m.find(2); std::cout << mi->second;
  std::unordered_map<int, int> um = {{3, 9}}; auto ui = um.end(); ui = um.find(3); std::cout << ui->second;
  Cursor a{v.begin(), 0}, b{v.begin() + 2, 1}; a = b; std::cout << *a.at;
  std::vector<int>::iterator p = v.begin(), q = v.end() - 1; std::swap(p, q); std::cout << *p << *q;
  auto best = v.begin(); for (auto k = v.begin(); k != v.end(); ++k) if (*k > *best) best = k; std::cout << *best;
  std::vector<std::vector<int>::iterator> its = {v.begin(), v.begin() + 1}; its[0] = v.end() - 1; std::cout << *its[0] << std::endl;
}
