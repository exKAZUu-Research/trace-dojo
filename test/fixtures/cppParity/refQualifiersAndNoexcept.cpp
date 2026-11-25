#include <iostream>
#include <string>
#include <new>
struct Tracker { std::string name; Tracker(std::string n) : name(n) { std::cout << "make " << name << "\n"; } ~Tracker() { std::cout << "drop " << name << "\n"; } };
struct S {
  int v = 1;
  int get() & { return v; }
  int get() && { return v * 100; }
  void only() & { std::cout << "lvalue only\n"; }
};
void safe() noexcept {}
void risky() {}
void old() throw() {}
int twice(int x) noexcept(true) { return x * 2; }
int main() {
  S s;
  std::cout << s.get() << " " << S().get() << " " << std::move(s).get() << "\n";
  s.only();
  std::cout << noexcept(safe()) << noexcept(risky()) << noexcept(1 + 2) << noexcept(old()) << noexcept(twice(1)) << "\n";

  Tracker* t = new Tracker("heap");
  t->~Tracker();

  std::cout << "end\n";
}
