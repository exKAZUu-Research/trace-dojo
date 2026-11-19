#include <iostream>

struct Base { int value = 7; };
struct Hidden : private Base {};

int main() {
  int values[] = {1, 0x11223344};
  void* erased = values + 1;
  int* exact = static_cast<int*>(erased);
  unsigned int* corresponding = static_cast<unsigned int*>(erased);
  unsigned char* bytes = static_cast<unsigned char*>(erased);
  std::cout << (exact == values + 1) << ' ' << corresponding[-1] << ' '
            << int(bytes[0]) << ' ' << int(bytes[3]) << '\n';
  *corresponding = 0x11223355u;
  bytes[1] = 0x66;
  void* erasedAgain = bytes;
  std::cout << std::hex << *static_cast<int*>(erasedAgain) << '\n';
  const void* nil = nullptr;
  std::cout << (static_cast<const int*>(nil) == nullptr) << '\n';
  Hidden hidden;
  std::cout << ((Base&)hidden).value << '\n';
}
