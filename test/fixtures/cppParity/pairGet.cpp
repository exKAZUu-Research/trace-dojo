#include <iostream>
#include <utility>
#include <string>
int main() {
  std::pair<int, std::string> p{1, "one"};
  std::get<0>(p) = 5;
  std::cout << std::get<0>(p) << std::get<1>(p) << std::get<std::string>(p) << "\n";
}
