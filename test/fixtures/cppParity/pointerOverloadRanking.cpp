#include <iostream>

void print(bool) { std::cout << 'B'; }
void print(const void*) { std::cout << 'P'; }
struct Base {};
struct Derived : Base {};
void report(bool) { std::cout << 'B'; }
void report(const Base*) { std::cout << 'D'; }
void choose(int* const*) { std::cout << 'S'; }
void choose(const int* const*) { std::cout << 'Q'; }
void deeper(int** const*) { std::cout << 'F'; }
void deeper(int* const* const*) { std::cout << 'M'; }

int main() {
  int x = 0;
  print(&x);
  Derived derived;
  report(&derived);
  int* pointer = &x;
  int** indirect = &pointer;
  const int* constant = &x;
  choose(indirect);
  choose(&constant);
  deeper(&indirect);
  std::cout << '\n';
}
