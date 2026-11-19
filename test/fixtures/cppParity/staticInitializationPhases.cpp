#include <iostream>

int observe();
int first = observe();
int scalar = 7;
int array[2][2] = {{8}, {9}};
int observe() { return scalar + array[0][0] + array[1][0]; }

struct Part {
  int field;
  Part() { std::cout << field; }
};

struct Counter {
  Part part;
  int entries[2];
  int field;
  Counter() { std::cout << entries[1] << field; }
};
Counter global;

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
  std::cout << ':' << first << ':';
  try {
    capture(-1);
  } catch (int) {
    std::cout << 'X';
  }
  capture(5);
  capture(6);
  std::cout << '\n';
}
