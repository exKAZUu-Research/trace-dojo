#include <iostream>
template <class T>
struct W {
  T* p;
  operator T&() const noexcept { return *p; }
};
int main() { int x = 4; W<int> w{&x}; int& r = w; r = 5; std::cout << x << "\n"; }
