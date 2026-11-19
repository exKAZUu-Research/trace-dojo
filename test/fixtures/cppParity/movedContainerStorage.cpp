#include <algorithm>
#include <iostream>
#include <vector>

int main() {
  std::vector<std::vector<int>> rows{{1}, {4}, {5}, {2}, {3}, {6}};
  rows[2].reserve(16);
  int* point = rows[2].data();
  rows.reserve(20);
  std::cout << *point << ' ' << rows[2].capacity() << ' ';
  std::sort(rows.begin(), rows.end());
  for (const auto& row : rows) std::cout << row[0];
  std::cout << ' ' << *point << ' ' << rows[4].capacity() << ' ' << (point == rows[4].data()) << '\n';
}
