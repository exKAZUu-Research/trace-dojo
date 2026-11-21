#include <iostream>
#include <vector>

std::vector<bool> flags{true};
int result = 0;

int& target() {
  flags[0] = false;
  return result;
}

int main() {
  int sums[] = {0};
  int differences[] = {2};
  int index = 0;
  std::vector<bool> bits{true, false};
  sums[index++] += bits[index];
  index = 0;
  differences[index++] -= bits[index];
  target() += flags[0];
  std::cout << sums[0] << differences[0] << result << '\n';
}
