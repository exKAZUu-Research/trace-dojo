#include <iostream>
#include <unordered_set>
int main() {
  std::unordered_set<int> s;
  for (int i = 0; i < 30; i++) s.insert(i * 7 % 31);
  for (auto it = s.begin(); it != s.end();) { if (*it % 3 == 0) it = s.erase(it); else ++it; }
  s.erase(4); s.erase(100);
  for (int x : s) std::cout << x << " ";
  std::cout << s.size() << std::endl;
  s.clear();
  s.rehash(100);
  std::cout << s.bucket_count() << ' ';
  s.rehash(0);
  std::cout << s.bucket_count() << '\n';
}
