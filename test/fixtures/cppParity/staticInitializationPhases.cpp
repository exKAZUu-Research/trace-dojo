#include <array>
#include <iostream>
#include <utility>

int observe();
int first = observe();
int scalar = 7;
int array[2][2] = {{8}, {9}};
int* addresses[] = {array[0] + 1, &array[1][0], &scalar};
int& alias = array[0][0];
const int& temporary = 2;
struct Plain { int value; };
Plain plain{7};
int* member = &plain.value;
int& memberAlias = plain.value;
int* chosen = true ? &scalar : &plain.value;
constexpr const int* source = &scalar;
const int* copied = source;
constexpr const int* empty = nullptr;
struct WithDefault { int value = 3; };
WithDefault defaulted{};
WithDefault overridden{4};
std::pair<int, int> pair{1, 2};
std::array<std::pair<int, int>, 2> nested{{{2, 3}, {4, 5}}};
int observe() { return *addresses[0] + *addresses[1] + *addresses[2] + alias + temporary + *member + memberAlias + *chosen + *copied
        + defaulted.value + overridden.value + pair.second + nested[1].second + (empty == nullptr); }

struct Part {
  int field;
  Part() { std::cout << field; }
};

struct Counter {
  Part part;
  int entries[2];
  int field;
  Counter() : field(entries[1]) { std::cout << entries[1] << field; }
};
Counter global;

struct Writes {
  int assigned;
  int entries[2][1];
  Writes() : assigned(entries[1][0] = 7) { std::cout << assigned << entries[1][0]; }
};
Writes writes;
struct Copy {
  Plain nested;
  int array[2];
};
Copy original{{7}, {8, 9}};
Copy duplicate = original;
int* duplicateMember = &duplicate.nested.value;
int* duplicateElement = &duplicate.array[1];

int save(int n) {
  if (n < 0) throw n;
  return n;
}

void capture(int n) {
  static int value{save(n)};
  static int values[][2]{{n, n + 1}};
  static Counter counter{};
  std::cout << value << values[0][1];
}

int main() {
  std::cout << ':' << first << ':' << *duplicateMember << *duplicateElement << ':';
  try {
    capture(-1);
  } catch (int) {
    std::cout << 'X';
  }
  capture(5);
  capture(6);
  std::cout << '\n';
}
