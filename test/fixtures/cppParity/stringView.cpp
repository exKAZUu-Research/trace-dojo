#include <iostream>
#include <string>
#include <string_view>
#include <vector>
using namespace std::literals;
int countVowels(std::string_view s) {
  int n = 0;
  for (char c : s)
    if (std::string_view("aeiou").find(c) != std::string_view::npos) n++;
  return n;
}
std::vector<std::string_view> split(std::string_view s, char sep) {
  std::vector<std::string_view> parts;
  while (true) {
    auto pos = s.find(sep);
    parts.push_back(s.substr(0, pos));
    if (pos == std::string_view::npos) break;
    s.remove_prefix(pos + 1);
  }
  return parts;
}
int main() {
  std::string text = "hello world";
  std::string_view v = text;
  std::cout << v << " " << v.size() << " " << sizeof(v) << " " << countVowels(text) << countVowels("banana") << "\n";
  std::cout << v.substr(6) << "|" << v.substr(0, 5) << "|" << v.find('o') << " " << v.rfind('o') << " " << v.find("wor") << "\n";
  for (auto part : split("a,bb,,ccc", ',')) std::cout << "[" << part << "]";
  std::cout << "\n";
  std::cout << v.starts_with("hell") << v.ends_with("xd") << (v == "hello world") << ("abc"sv < "abd"sv) << "\n";
  std::string back(v.substr(0, 4));
  std::cout << back << " " << v.front() << v.back() << " " << v.find_first_of("ol") << v.find_last_not_of("dlr") << "\n";
  try {
    v.substr(20);
  } catch (const std::out_of_range& e) {
    std::cout << e.what() << "\n";
  }
  auto literal = "lit"sv;
  std::cout << literal.size() << literal << "\n";
}
