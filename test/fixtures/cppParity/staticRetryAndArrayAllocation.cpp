#include <iostream>

int attempts = 0;
int initial() {
  if (++attempts == 1) throw 1;
  return 7;
}
int get() {
  static int value = initial();
  return value;
}

int main() {
  try { get(); }
  catch (int n) { std::cout << n << '\n'; }
  std::cout << get() << ' ' << get() << ' ' << attempts << '\n';
  auto matrix = new int[2][3]();
  std::cout << matrix[1][2] << '\n';
  delete[] matrix;
}
