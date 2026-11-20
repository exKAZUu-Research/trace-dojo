#include <iostream>

int global[600000] = {9};
int matrix[2][2] = {{4,5},{6,7}};
int* getGlobal() { return global; }
int& first = global[0];
const int& held = 7;

int main() {
  static int local[300000] = {};
  int x = 2;
  int* p = &x;
  const int* q = &x;
  int** left = &p;
  const int** right = &q;
  const int* const* joined = true ? left : right;
  first += held;
  std::cout << getGlobal()[0] << global[599999] << matrix[1][0] << local[299999] << **joined;
}
