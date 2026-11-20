#include <iostream>

int main() {
  auto words = new const char*[2]{"first", "second"};
  auto value = new int const{7};
  auto pointer = new int* const{nullptr};
  std::cout << words[1] << ' ' << *value << ' ' << (*pointer == nullptr) << '\n';

  switch (long{5})
    case 5:
    default:
      std::cout << "matched\n";
  switch (short{0})
    std::cout << "unreachable\n";
  switch (unsigned{2}) {
    case 1:
      std::cout << "unreachable\n";
      break;
    case 2:
      std::cout << "case two\n";
    default:
      std::cout << "fallthrough\n";
  }

  delete[] words;
  delete value;
  delete pointer;
}
