#include <iostream>

int cells[2] = {4, 7};
int global(cells[1]);
int read(int values[2]);

struct Pair {
  int sum;
  Pair(int first, int second) : sum(first + second) {}
};

int read(int values[2]) { return values[1]; }

int main() {
  int local[] = {3, 8};
  int selected(local[1]);
  int* pointers[] = {&local[1]};
  int* pointer(pointers[0]);
  int& reference(local[0]);
  static int saved(local[1]);
  int table[2][2] = {{1, 2}, {5, 6}};
  Pair combined(table[1][0], local[0]);
  ++reference;
  std::cout << global << selected << *pointer << reference << saved << combined.sum << read(cells) << '\n';
}
