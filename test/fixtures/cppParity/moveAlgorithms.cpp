#include <algorithm>
#include <cstdio>
#include <iostream>
#include <new>
#include <string>
#include <utility>
#include <vector>
int main() {
  std::vector<std::string> a{"x", "y", "z"}, b(3);
  std::move(a.begin(), a.end(), b.begin());
  std::cout << b[0] << b[2] << a[0].size() << "\n";
  std::move_backward(b.begin(), b.begin() + 2, b.end());
  std::cout << b[1] << b[2] << "\n";
  int* p = new (std::nothrow) int(5);
  int* arr = new (std::nothrow) int[3]{1, 2, 3};
  std::cout << *p << arr[2] << (p != nullptr) << "\n";
  delete p;
  delete[] arr;
}
int extra = [] {
  std::vector<int> v{1, 2, 3, 4, 5};
  std::copy_backward(v.begin(), v.begin() + 3, v.begin() + 5);
  for (int x : v) std::cout << x;
  std::cout << "\n";
  return 0;
}();
