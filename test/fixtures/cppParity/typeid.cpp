#include <iostream>
#include <typeinfo>
#include <string>
#include <vector>
namespace geo { struct Point {}; namespace inner { struct Deep {}; } }
template <class T, class U> struct Pair {};
struct Base { virtual ~Base() = default; };
struct Derived : Base { struct Nested {}; };
enum Color { Red };
int main() {
  int i; double d; char c; bool b; long l; unsigned u; float f; long long ll; unsigned char uc; short s;
  std::cout << typeid(i).name() << typeid(d).name() << typeid(c).name() << typeid(b).name() << typeid(l).name()
            << typeid(u).name() << typeid(f).name() << typeid(ll).name() << typeid(uc).name() << typeid(s).name() << "\n";
  std::cout << typeid(int*).name() << " " << typeid(const char*).name() << " " << typeid(int[3]).name() << " " << typeid(int**).name() << "\n";
  std::cout << typeid(Base).name() << " " << typeid(geo::Point).name() << " " << typeid(geo::inner::Deep).name() << " " << typeid(Derived::Nested).name() << "\n";
  std::cout << typeid(Pair<int, double>).name() << " " << typeid(Pair<Base, Base>).name() << " " << typeid(Color).name() << "\n";
  Base* p = new Derived;
  std::cout << typeid(*p).name() << " " << (typeid(*p) == typeid(Derived)) << (typeid(*p) == typeid(Base)) << (typeid(p) == typeid(Base*)) << "\n";
  std::cout << typeid(std::string).name() << "\n";
  std::cout << typeid(int(int, double)).name() << " " << typeid(void (*)()).name() << " " << typeid(const int).name() << "\n";
  delete p;
}
