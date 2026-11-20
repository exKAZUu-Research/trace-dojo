#include <iostream>
#include <vector>

struct Guard {
  ~Guard() { std::cout << 'D'; }
};

struct Owner {
  int values[2];
  ~Owner() { std::cout << 'O'; }
};

std::vector<int> values{1, 2};
std::vector<int>& existing(const Guard&) { return values; }

int main() {
  for (int number : (Guard{}, values)) std::cout << number;
  std::cout << '\n';
  for (int number : existing(Guard{})) std::cout << number;
  std::cout << '\n';
  for (int number : (Guard{}, Owner{{3, 4}}.values)) std::cout << number;
  std::cout << '\n';
  for (int number : (Guard{}, std::vector<int>{5, 6})) std::cout << number;
  std::cout << '\n';
}
