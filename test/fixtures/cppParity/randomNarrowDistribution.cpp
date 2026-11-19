#include <iostream>
#include <random>

int main() {
  std::mt19937 engine(42);
  engine.discard(12);
  std::uniform_int_distribution<short> small;
  std::uniform_int_distribution<unsigned short> unsignedSmall;
  std::uniform_int_distribution<short> negative(-50, -10);
  std::cout << small.max() << ' ' << unsignedSmall.max() << '\n';
  for (int i = 0; i < 4; ++i)
    std::cout << small(engine) << ' ' << unsignedSmall(engine) << ' ' << negative(engine) << '\n';
}
