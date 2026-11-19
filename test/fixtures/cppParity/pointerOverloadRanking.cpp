#include <iostream>

void print(bool) { std::cout << 'B'; }
void print(const void*) { std::cout << 'P'; }
struct Base {};
struct Derived : Base {};
void report(bool) { std::cout << 'B'; }
void report(const Base*) { std::cout << 'D'; }

int main() {
  int x = 0;
  print(&x);
  Derived derived;
  report(&derived);
  std::cout << '\n';
}
