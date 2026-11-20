#include <cstring>
#include <iostream>
#include <string>

int main() {
  char raw[3] = {'a', '\0', 'b'};
  char identical[3] = {'a', 'b', 'c'};
  char target[5];
  std::strncpy(target, identical, 3);
  std::cout << std::strncmp(identical, target, 3) << '\n';
  std::strncpy(target, raw, 5);
  std::cout << target[0] << ' ' << int(target[2]) << ' ' << int(target[4]) << '\n';

  std::string text{"za\0bzabc", 8};
  std::cout << text.find(raw, 0, 3) << ' ' << text.rfind(identical, text.size(), 3) << '\n';
  std::cout << text.find_first_of(raw + 1, 0, 2) << '\n';
}
