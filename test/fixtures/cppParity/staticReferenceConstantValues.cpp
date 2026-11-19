#include <iostream>

const int count = 3;
const int& alias = count;
constexpr double rate = 1.5;

struct Holder {
  inline static constexpr const int& retained = 4;
  static const int& named;
  static constexpr const int& forwarded = alias;
  inline static const double& namedRate = rate;
  inline static constexpr const float& retainedRate = 2.5f;
};

const int& Holder::named{count};
constexpr int length = Holder::retained + Holder::named + Holder::forwarded;
int values[length];
constexpr double totalRate = Holder::namedRate + Holder::retainedRate;

Holder receiver() { std::cout << "receiver\n"; return Holder{}; }

int main() {
  const int& fromGlobal = Holder::named;
  const int& localAlias = fromGlobal;
  constexpr const int& explicitAlias = count;
  const int& fromExplicit = explicitAlias;
  static const int localCount = 6;
  const int& fromStatic = localCount;
  static const int& literal = 5;
  const int& fromLiteral = literal;
  constexpr int local = localAlias + fromExplicit + fromStatic + fromLiteral;
  static const int* earlyAddress = &localAlias;
  static const int* scopedAddress = &fromLiteral;
  std::cout << sizeof(values) << ' ' << local << ' '
            << *earlyAddress << ' ' << *scopedAddress << '\n';
  std::cout << receiver().retained << '\n';
  std::cout << totalRate << '\n';
}
