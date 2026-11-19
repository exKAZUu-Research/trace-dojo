#include <iostream>

const int count = 3;
const int& alias = count;

struct Holder {
  inline static constexpr const int& retained = 4;
  static const int& named;
  static constexpr const int& forwarded = alias;
};

const int& Holder::named{count};
constexpr int length = Holder::retained + Holder::named + Holder::forwarded;
int values[length];

Holder receiver() { std::cout << "receiver\n"; return Holder{}; }

int main() {
  const int& fromGlobal = Holder::named;
  static const int& literal = 5;
  constexpr int local = fromGlobal + literal;
  std::cout << sizeof(values) << ' ' << local << '\n';
  std::cout << receiver().retained << '\n';
}
