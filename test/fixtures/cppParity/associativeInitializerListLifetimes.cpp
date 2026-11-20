#include <iostream>
#include <map>
#include <unordered_map>

int fail = 0;
int failCopies = 0;
int copiesUntilThrow = 0;

struct Entry {
  int value;
  Entry(int n) : value(n) { std::cout << 'N' << n; }
  Entry(const Entry& other) : value(other.value) {
    std::cout << 'C' << value;
    if (copiesUntilThrow > 0 && --copiesUntilThrow == 0) throw value;
    if (value == fail && ++failCopies == 2) throw value;
  }
  ~Entry() { std::cout << 'D'; }
};

int main() {
  {
    std::map<int, Entry> entries{{1, Entry(1)}, {1, Entry(2)}};
    std::cout << 'X' << entries.begin()->second.value;
  }
  std::cout << '\n';
  {
    std::unordered_map<int, Entry> entries{{1, Entry(1)}, {1, Entry(2)}};
    std::cout << 'X' << entries.begin()->second.value;
  }
  std::cout << '\n';
  {
    std::multimap<int, Entry> entries{{1, Entry(1)}, {1, Entry(2)}};
    std::cout << 'X' << entries.size();
  }
  std::cout << '\n';

  fail = 2;
  try {
    std::map<int, Entry> entries{{1, Entry(1)}, {2, Entry(2)}};
  } catch (int value) {
    std::cout << 'X' << value << '\n';
  }
  failCopies = 0;
  try {
    std::unordered_map<int, Entry> entries{{1, Entry(1)}, {2, Entry(2)}};
  } catch (int value) {
    std::cout << 'X' << value << '\n';
  }

  fail = 0;
  {
    std::map<int, Entry> source;
    source.try_emplace(1, 1);
    source.try_emplace(2, 2);
    copiesUntilThrow = 2;
    try {
      auto copy = source;
    } catch (int value) {
      std::cout << 'X' << value;
    }
  }
  std::cout << '\n';
  {
    std::multimap<int, Entry> source;
    source.emplace(1, 1);
    source.emplace(2, 2);
    copiesUntilThrow = 2;
    try {
      auto copy = source;
    } catch (int value) {
      std::cout << 'X' << value;
    }
  }
  std::cout << '\n';
  {
    std::unordered_map<int, Entry> source;
    source.try_emplace(1, 1);
    source.try_emplace(2, 2);
    copiesUntilThrow = 2;
    try {
      auto copy = source;
    } catch (int value) {
      std::cout << 'X' << value;
    }
  }
  std::cout << '\n';
}
