#include <array>
#include <deque>
#include <iostream>
#include <list>
#include <map>
#include <string>
#include <unordered_map>
#include <vector>

struct Cursor {
  std::deque<int>::iterator place;
  int value;
};

struct ArrayOwner {
  std::array<int, 2> values;
  int tag;
};

int main() {
  std::array<int, 2> array{};
  std::vector<int> vector;
  std::vector<bool> bits;
  std::deque<int> deque;
  std::list<int> list;
  std::map<int, int> map;
  std::unordered_map<int, int> hash;
  std::string string;
  std::cout << sizeof(array.begin()) << ' ' << sizeof(array.rbegin()) << ' '
            << sizeof(vector.begin()) << ' ' << sizeof(vector.rbegin()) << '\n';
  std::cout << sizeof(bits.begin()) << ' ' << sizeof(bits.cbegin()) << ' ' << sizeof(bits.crbegin()) << '\n';
  std::cout << sizeof(deque.begin()) << ' ' << sizeof(deque.cbegin()) << ' ' << sizeof(deque.rbegin()) << '\n';
  std::cout << sizeof(list.begin()) << ' ' << sizeof(list.rbegin()) << ' ' << sizeof(map.begin()) << ' '
            << sizeof(map.rbegin()) << ' ' << sizeof(hash.begin()) << ' ' << sizeof(string.begin()) << ' '
            << sizeof(string.rbegin()) << '\n';
  std::cout << sizeof(Cursor) << '\n';
  ArrayOwner owner{{3, 4}, 5};
  ArrayOwner copied = owner;
  std::array<int, 2> standalone{6, 7};
  std::array<std::array<int, 2>, 1> nested{8, 9};
  std::array<int, 0> empty{};
  std::cout << (static_cast<void*>(owner.values.data()) == static_cast<void*>(&owner))
            << (static_cast<void*>(copied.values.data()) == static_cast<void*>(&copied))
            << (owner.values.data() != copied.values.data()) << '\n';
  std::cout << (static_cast<void*>(&standalone) == static_cast<void*>(standalone.data()))
            << (static_cast<void*>(&standalone + 1) == static_cast<void*>(standalone.data() + standalone.size()))
            << (static_cast<void*>(&nested) == static_cast<void*>(nested[0].data()))
            << (static_cast<void*>(&empty) != static_cast<void*>(empty.data())) << '\n';
}
