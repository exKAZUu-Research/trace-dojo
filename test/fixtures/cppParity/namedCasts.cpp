#include <iostream>
#include <typeinfo>
struct Animal { virtual ~Animal() = default; virtual const char* name() const { return "animal"; } };
struct Dog : Animal { const char* name() const override { return "dog"; } void bark() const { std::cout << "woof\n"; } };
struct Cat : Animal { const char* name() const override { return "cat"; } };
void inspect(Animal* a) {
  if (Dog* d = dynamic_cast<Dog*>(a)) d->bark();
  else std::cout << "not a dog: " << a->name() << "\n";
}
int main() {
  Dog dog; Cat cat;
  inspect(&dog); inspect(&cat);
  Animal& ref = cat;
  try { Dog& d = dynamic_cast<Dog&>(ref); d.bark(); } catch (const std::bad_cast& e) { std::cout << "bad_cast " << e.what() << "\n"; }
  const int x = 5;
  int* p = const_cast<int*>(&x);
  const Dog& cd = dog;
  Dog& md = const_cast<Dog&>(cd);
  md.bark();
  int y = 7;
  int* q = reinterpret_cast<int*>(&y);
  std::cout << *p << *q << static_cast<double>(y) / 2 << "\n";
  Animal* none = nullptr;
  std::cout << (dynamic_cast<Cat*>(none) == nullptr) << "\n";
}
