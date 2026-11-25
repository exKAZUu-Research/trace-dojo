#include <iostream>
#include <vector>
#include <algorithm>
int twice(int x) { return x * 2; }
int square(int x) { return x * x; }
int add(int a, int b) { return a + b; }
bool desc(int a, int b) { return a > b; }
int apply(int (*f)(int), int v) { return f(v); }
using BinOp = int (*)(int, int);
typedef int (*UnOp)(int);
int fold(const std::vector<int>& v, BinOp op, int init) { for (int x : v) init = op(init, x); return init; }
int main() {
  int (*fp)(int) = twice;
  std::cout << fp(5) << " " << (*fp)(6) << "\n";
  fp = &square;
  std::cout << fp(5) << " " << apply(twice, 7) << " " << apply(square, 3) << "\n";
  UnOp table[2] = {twice, square};
  for (UnOp op : table) std::cout << op(10) << " ";
  std::cout << "\n";
  std::vector<int> v = {3, 1, 2};
  std::cout << fold(v, add, 0) << "\n";
  bool (*cmp)(int, int) = desc;
  std::sort(v.begin(), v.end(), cmp);
  for (int x : v) std::cout << x;
  std::cout << "\n";
  auto g = twice;
  auto h = &square;
  std::cout << g(1) << h(2) << (fp == h) << (fp != nullptr) << "\n";
  int (*q)(int) = nullptr;
  if (!q) std::cout << "null\n";
  int (*lam)(int) = [](int x) { return x + 100; };
  std::cout << lam(1) << apply([](int x) { return -x; }, 9) << "\n";
  int a[3] = {1, 2, 3};
  int (*pa)[3] = &a;
  std::cout << (*pa)[2] << sizeof(pa) << "\n";
}
