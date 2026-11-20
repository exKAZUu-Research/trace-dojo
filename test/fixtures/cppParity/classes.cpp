#include <iostream>
#include <string>
using namespace std;
class Animal {
 public:
  Animal(const string& name) : name(name) { cout << "Animal(" << name << ")" << endl; }
  Animal(const Animal& other) : name(other.name + "'") { cout << "copy " << name << endl; }
  virtual ~Animal() { cout << "~Animal(" << name << ")" << endl; }
  virtual string sound() const { return "..."; }
  void speak() const { cout << name << " says " << sound() << endl; }
  static int count;
 protected:
  string name;
};
int Animal::count = 0;
class Dog : public Animal {
 public:
  Dog(const string& name) : Animal(name) { count++; cout << "Dog" << endl; }
  ~Dog() override { cout << "~Dog" << endl; }
  string sound() const override { return "Woof"; }
};
class Cat : public Animal {
 public:
  Cat() : Animal("cat") {}
  string sound() const override { return "Meow"; }
};
struct Point { int x; int y; };
class Counter {
  int value = 0;
 public:
  void inc() { value++; }
  int get() const { return value; }
};
Animal makeAnimal() { Animal a("tmp"); return a; }
void byValue(Animal a) { a.speak(); }
void byRef(const Animal& a) { a.speak(); }
int main() {
  Dog d("rex");
  Cat c;
  d.speak(); c.speak();
  Animal* p = new Dog("fido");
  p->speak();
  delete p;
  Animal& ref = c; ref.speak();
  byRef(d);
  byValue(d);
  Animal m = makeAnimal();
  m.speak();
  cout << Animal::count << endl;
  Point pt = {3, 4}; Point q{5, 6}; Point r = pt;
  r.x = 9;
  cout << pt.x << pt.y << q.x << q.y << r.x << endl;
  Counter cnt; cnt.inc(); cnt.inc(); cout << cnt.get() << endl;
  {
    Dog inner("inner");
  }
  cout << "end" << endl;
}
