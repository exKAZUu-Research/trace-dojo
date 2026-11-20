#include <algorithm>
#include <iostream>
#include <string>
#include <utility>
#include <vector>
struct P { int key; int id; };
bool byKey(const P& a, const P& b) { return a.key < b.key; }
bool byFirst(const std::pair<int, int>& a, const std::pair<int, int>& b) { return a.first > b.first; }
bool byHead(const std::string& a, const std::string& b) { return a[0] < b[0]; }
bool byMod(int a, int b) { return a % 6 < b % 6; }
int main() {
  int ns[] = {10, 23, 24, 25, 40, 129, 200};
  for (int n : ns) {
    std::vector<P> v;
    unsigned s = n * 7919u;
    for (int i = 0; i < n; i++) { s = s * 1103515245u + 12345u; v.push_back({(int)((s >> 16) % 5), i}); }
    std::sort(v.begin(), v.end(), byKey);
    std::cout << n << ':';
    for (auto& p : v) std::cout << ' ' << p.id;
    std::cout << '\n';
    std::vector<std::pair<int, int>> w;
    for (int i = 0; i < n; i++) w.push_back({(int)((i * 37) % 4), i});
    std::sort(w.begin(), w.end(), byFirst);
    for (auto& p : w) std::cout << ' ' << p.second;
    std::cout << '\n';
    std::vector<std::string> t;
    for (int i = 0; i < n; i++) t.push_back(std::string(1, 'a' + i % 3) + std::to_string(i));
    std::sort(t.begin(), t.end(), byHead);
    for (auto& x : t) std::cout << ' ' << x;
    std::cout << '\n';
    std::vector<int> u;
    for (int i = 0; i < n; i++) u.push_back(i);
    std::sort(u.begin(), u.end(), byMod);
    for (int x : u) std::cout << ' ' << x;
    std::cout << '\n';
  }
}
