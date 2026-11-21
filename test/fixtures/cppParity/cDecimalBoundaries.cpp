#include <cstdlib>
#include <iostream>

int main() {
  std::cout << std::atoi(" +2147483647 tail") << ' ' << std::atoi("-2147483648") << '\n';
  std::cout << std::atol("9223372036854775807") << ' ' << std::atol(" -9223372036854775808x") << '\n';
  std::cout << std::atoi("x23") << ' ' << std::atol(" +") << '\n';
}
