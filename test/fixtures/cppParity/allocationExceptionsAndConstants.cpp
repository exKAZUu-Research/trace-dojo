#include <iostream>

constexpr unsigned long capacity{4};

int main() {
  static constexpr int width = 3;
  constexpr int zero{};
  int lengths[capacity + width];
  std::cout << sizeof(lengths) << ' ' << zero << ' ';
  try {
    throw std::bad_array_new_length();
  } catch (const std::bad_alloc& error) {
    std::cout << error.what();
  }
}
