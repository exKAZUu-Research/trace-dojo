#include <iostream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
struct PairHash {
  std::size_t operator()(const std::pair<int, int>& p) const { return std::hash<int>{}(p.first) ^ (std::hash<int>{}(p.second) << 1); }
};
struct CaseInsensitiveHash {
  std::size_t operator()(const std::string& s) const {
    std::size_t h = 0;
    for (char c : s) h = h * 31 + static_cast<std::size_t>(std::tolower(static_cast<unsigned char>(c)));
    return h;
  }
};
struct CaseInsensitiveEqual {
  bool operator()(const std::string& a, const std::string& b) const {
    if (a.size() != b.size()) return false;
    for (std::size_t i = 0; i < a.size(); ++i)
      if (std::tolower(static_cast<unsigned char>(a[i])) != std::tolower(static_cast<unsigned char>(b[i]))) return false;
    return true;
  }
};
int main() {
  std::unordered_map<std::pair<int, int>, int, PairHash> grid;
  grid[{1, 2}] = 5;
  grid[{2, 1}] = 7;
  grid[{1, 2}] += 1;
  for (const auto& [k, v] : grid) std::cout << k.first << "," << k.second << "=" << v << "\n";
  std::unordered_set<std::string, CaseInsensitiveHash, CaseInsensitiveEqual> words{"Apple", "apple", "BANANA", "banana", "cherry"};
  std::cout << words.size() << " " << words.count("APPLE") << "\n";
  auto lambdaHash = [](int x) { return static_cast<std::size_t>(x % 3); };
  std::unordered_set<int, decltype(lambdaHash)> mod3{1, 2, 3, 4, 5, 6};
  for (int x : mod3) std::cout << x;
  std::cout << "\n";
}
