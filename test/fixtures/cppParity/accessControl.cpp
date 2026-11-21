#include <iostream>

class Base {
 protected:
  int shared = 1;
  static int twice(int x) { return 2 * x; }

 public:
  int open = 3;
  int sum(const Base& other) const { return shared + other.shared; }
};

class Derived : public Base {
 public:
  int viaSelf(Derived& other) { return other.shared + this->shared + shared + Base::shared + this->Base::shared; }
  int viaStatic() { return twice(shared) + Base::twice(open); }
};

class Hidden : private Base {
 public:
  int inside() { return shared + open + Base::open; }
  Base* asBase() { return this; }
};

class Middle : protected Base {};

class Leaf : public Middle {
 public:
  int reach() { return shared + open; }
  Base& asBase() { return *this; }
};

class Counter {
  static int count;
  ~Counter() {}

 public:
  static Counter* make() {
    ++count;
    return new Counter();
  }
  void destroy() { delete this; }
  static int made() { return count; }
};
int Counter::count = 0;

struct Fixed {
  const int id;
  int& target;
};

class Labeled {
  const int label;

 public:
  Labeled(int label) : label(label) {}
  int get() const { return label; }
};

void choose(int) { std::cout << "int\n"; }
void choose(bool) { std::cout << "bool\n"; }
void pick(double) { std::cout << "double\n"; }
void pick(bool) { std::cout << "bool\n"; }

int main() {
  Derived a;
  Derived b;
  std::cout << a.viaSelf(b) << ' ' << a.viaStatic() << ' ' << a.sum(b) << '\n';
  Hidden hidden;
  std::cout << hidden.inside() << ' ' << hidden.asBase()->open << '\n';
  Leaf leaf;
  std::cout << leaf.reach() << ' ' << leaf.asBase().open << '\n';
  Counter* counter = Counter::make();
  counter->destroy();
  std::cout << Counter::made() << '\n';
  int value = 4;
  Fixed fixed{5, value};
  Fixed copy = fixed;
  copy.target = 6;
  std::cout << copy.id << ' ' << value << '\n';
  Labeled labeled(7);
  Labeled other = labeled;
  std::cout << other.get() << '\n';
  int* pointer = &value;
  choose(true);
  choose('a');
  choose(pointer);
  pick(1.5f);
  pick(pointer);
}
