#include <cstddef>
#include <deque>
#include <iostream>
#include <list>
#include <stack>
#include <vector>

constexpr bool globalFlag{nullptr};
constexpr std::nullptr_t empty = nullptr;
constexpr std::nullptr_t emptyCopy = empty;
constexpr bool namedGlobal(empty);
constexpr bool castGlobal = static_cast<bool>(empty);
constexpr int* pointerFromName = emptyCopy;
constexpr const int* pointerFromCast = static_cast<const int*>(empty);

struct Flags {
  bool fromDefault{nullptr};
  bool fromConstructor;
  static constexpr bool constant{nullptr};
  Flags() : fromConstructor(nullptr) {}
};

std::nullptr_t call() {
  std::cout << "call ";
  return nullptr;
}

struct NullSlot {
  std::nullptr_t value;
};

int main() {
  Flags flags;
  bool parenthesized(nullptr);
  bool braced{nullptr};
  constexpr bool constexprFlag(nullptr);
  static bool localStatic{nullptr};
  constexpr std::nullptr_t namedLocal = nullptr;
  constexpr bool localBraced{namedLocal};
  std::nullptr_t unread;
  constexpr bool noRead(unread);
  NullSlot local{nullptr};
  constexpr bool member{local.value};
  bool* allocated = new bool(nullptr);
  bool* allocatedList = new bool{nullptr};
  std::cout << globalFlag << flags.fromDefault << flags.fromConstructor << Flags::constant << '\n';
  std::cout << parenthesized << braced << constexprFlag << localStatic << *allocated << *allocatedList << '\n';
  std::cout << static_cast<bool>(nullptr) << bool(nullptr) << bool{nullptr} << ((bool)nullptr) << '\n';
  std::cout << namedGlobal << castGlobal << localBraced << noRead << member << '\n';
  std::cout << (pointerFromName == nullptr) << (pointerFromCast == nullptr) << '\n';
  std::cout << bool(call()) << '\n';
  std::vector<bool> bits;
  std::deque<bool> flagsInOrder;
  std::stack<bool> flagsOnStack;
  bits.emplace_back(nullptr);
  flagsInOrder.emplace_front(nullptr);
  flagsOnStack.emplace(nullptr);
  std::cout << bits[0] << flagsInOrder.front() << flagsOnStack.top() << '\n';
  std::nullptr_t nulls[] = {nullptr, nullptr};
  std::deque<bool> directRange(nulls, nulls + 2);
  std::list<bool> linkedRange(nulls, nulls + 1);
  linkedRange.insert(linkedRange.end(), nulls, nulls + 2);
  int numbers[] = {0, 8};
  std::vector<bool> bitRange(numbers, numbers + 2);
  bitRange.assign(numbers + 1, numbers + 2);
  bitRange.insert(bitRange.end(), numbers, numbers + 1);
  std::cout << directRange[0] << directRange[1] << linkedRange.size() << linkedRange.back()
            << bitRange[0] << bitRange[1] << '\n';
  delete allocated;
  delete allocatedList;
}
