#include <iostream>
struct Animal {
  int legs;
  Animal(int n = 4) : legs(n) { std::cout << "Animal " << n << "\n"; }
  virtual ~Animal() { std::cout << "~Animal\n"; }
  virtual const char* sound() const { return "..."; }
};
struct Mammal : virtual Animal {
  Mammal() : Animal(2) { std::cout << "Mammal\n"; }
  ~Mammal() override { std::cout << "~Mammal\n"; }
};
struct Winged : virtual public Animal {
  int wings = 2;
  Winged() { std::cout << "Winged\n"; }
  ~Winged() override { std::cout << "~Winged\n"; }
  const char* sound() const override { return "flap"; }
};
struct Bat : Mammal, Winged {
  Bat() : Animal(5) { std::cout << "Bat\n"; }
  ~Bat() override { std::cout << "~Bat\n"; }
};
int main() {
  {
    Bat b;
    b.legs = 3;
    Mammal& m = b;
    Winged& w = b;
    Animal& a = b;
    std::cout << b.legs << m.legs << w.legs << a.legs << " " << a.sound() << " " << b.wings << "\n";
    w.legs = 9;
    std::cout << m.legs << " " << (&static_cast<Animal&>(m) == &static_cast<Animal&>(w)) << "\n";
  }
  Mammal solo;
  std::cout << solo.legs << " " << solo.sound() << "\n";
  Animal* p = new Bat;
  std::cout << p->sound() << "\n";
  delete p;
}
