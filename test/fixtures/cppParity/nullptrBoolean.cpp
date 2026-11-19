#include <iostream>

constexpr bool globalFlag{nullptr};
struct Flags {
  bool fromDefault{nullptr};
  bool fromConstructor;
  static constexpr bool constant{nullptr};
  Flags() : fromConstructor(nullptr) {}
};

int main() {
  Flags flags;
  bool parenthesized(nullptr);
  bool braced{nullptr};
  constexpr bool constexprFlag(nullptr);
  static bool localStatic{nullptr};
  bool* allocated = new bool(nullptr);
  bool* allocatedList = new bool{nullptr};
  std::cout << globalFlag << flags.fromDefault << flags.fromConstructor << Flags::constant << '\n';
  std::cout << parenthesized << braced << constexprFlag << localStatic << *allocated << *allocatedList << '\n';
  std::cout << static_cast<bool>(nullptr) << bool(nullptr) << bool{nullptr} << ((bool)nullptr) << '\n';
  delete allocated;
  delete allocatedList;
}
