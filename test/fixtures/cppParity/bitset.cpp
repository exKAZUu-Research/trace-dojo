#include <iostream>
#include <bitset>
#include <string>
#include <stdexcept>
int main() {
  std::bitset<8> a(5), b("1100");
  std::cout << a << " " << b << " " << (a | b) << " " << (a & b) << " " << (a ^ b) << " " << ~a << "\n";
  std::cout << a.count() << " " << a.size() << " " << a.test(0) << a[1] << " " << (a << 2) << " " << (b >> 1) << "\n";
  a.set(7);
  a[1] = true;
  a.flip(0);
  std::cout << a << " " << a.to_ulong() << " " << a.to_string('.', '#') << " " << a.any() << a.none() << a.all() << "\n";
  std::bitset<70> big;
  big.set(69);
  big.set(3);
  std::cout << big.count() << " " << sizeof(big) << " " << sizeof(std::bitset<8>) << " " << big[69] << "\n";
  try {
    big.to_ulong();
  } catch (const std::overflow_error& e) {
    std::cout << e.what() << "\n";
  }
  try {
    a.test(9);
  } catch (const std::out_of_range& e) {
    std::cout << e.what() << "\n";
  }
  try {
    std::bitset<4> bad("10x1");
  } catch (const std::invalid_argument& e) {
    std::cout << e.what() << "\n";
  }
  std::bitset<4> e;
  e.set();
  std::cout << e << " " << (e == std::bitset<4>(15)) << " " << std::bitset<16>(1000).count() << "\n";
}
