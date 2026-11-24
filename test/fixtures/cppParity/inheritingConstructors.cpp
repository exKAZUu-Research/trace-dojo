#include <iostream>
#include <stdexcept>
#include <string>
struct AppError : std::runtime_error { using std::runtime_error::runtime_error; };
struct Base {
  int v;
  Base(int x) : v(x) {}
  Base(int x, int y) : v(x * y) {}
  void show(int) const { std::cout << "Base::show(int)\n"; }
  void show(const std::string&) const { std::cout << "Base::show(string)\n"; }
};
struct Derived : Base {
  using Base::Base;
  using Base::show;
  int extra = 5;
  void show(double) const { std::cout << "Derived::show(double)\n"; }
};
int main() {
  try { throw AppError("custom failure"); } catch (const std::exception& e) { std::cout << e.what() << "\n"; }
  Derived a(3), b(2, 4);
  std::cout << a.v << " " << b.v << " " << a.extra << "\n";
  a.show(1); a.show(std::string("s")); a.show(1.5);
}
