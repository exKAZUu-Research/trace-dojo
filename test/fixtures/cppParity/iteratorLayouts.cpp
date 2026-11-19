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
}
