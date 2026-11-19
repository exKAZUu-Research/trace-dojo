#include <algorithm>
#include <array>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <utility>
#include <vector>

struct Base { int n = 1; int get() { return n; } };
struct Derived : Base { int n = 2; int get() { return n; } };
int select(const Base*) { return 3; }
int select(void*) { return 4; }

struct Message : std::runtime_error {
  Message(const char* value) : std::runtime_error(value) {}
};
int max(int a, int b) { return a + b; }

int main() {
  bool previous = std::ios::sync_with_stdio(false);
  std::cout << previous << ' ';
  Derived d;
  std::cout << static_cast<Base&>(d).get() << ((Base&)d).get()
            << static_cast<Derived&>(static_cast<Base&>(d)).get() << select(&d) << ' ';
  std::cout << sizeof(std::array<int, 3>) << ' ' << sizeof(std::array<long, 0>) << ' '
            << sizeof(std::pair<char, int>) << ' ' << sizeof(std::pair<long, char>) << ' ';
  Message original("named");
  try { throw original; } catch (const std::exception& e) { std::cout << e.what() << ' '; }
  std::istringstream mode(std::ios_base::in);
  mode.str("ready");
  std::cout << mode.str() << ' ';
  std::map<std::pair<int, int>, int> pairs;
  pairs[{1, 2}] = 7;
  std::cout << pairs[{1, 2}] << ' ';
  std::vector<int> a{5}, b{8};
  swap(a, b);
  using namespace std;
  cout << a[0] << max(1, 2);
}
