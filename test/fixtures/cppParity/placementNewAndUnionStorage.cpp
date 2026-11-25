#include <iostream>
#include <new>
#include <string>
template <class T>
union Storage {
  char none;
  T value;
  Storage() : none() {}
  ~Storage() {}
};
template <class T>
class Maybe {
  Storage<T> s;
  bool has = false;
public:
  Maybe() {}
  Maybe(const T& v) { new (&s.value) T(v); has = true; }
  ~Maybe() { reset(); }
  void reset() { if (has) { s.value.~T(); has = false; } }
  void set(const T& v) { reset(); new (&s.value) T(v); has = true; }
  bool hasValue() const { return has; }
  const T& get() const { return s.value; }
};
struct Noisy {
  int id;
  Noisy(int i) : id(i) { std::cout << "make " << id << "\n"; }
  Noisy(const Noisy& o) : id(o.id) { std::cout << "copy " << id << "\n"; }
  ~Noisy() { std::cout << "drop " << id << "\n"; }
};
int main() {
  Maybe<std::string> a("hello");
  std::cout << a.get() << " " << sizeof(a) << "\n";
  a.set("world");
  std::cout << a.get() << "\n";
  Maybe<int> b;
  std::cout << b.hasValue() << " " << sizeof(b) << "\n";
  b.set(3);
  std::cout << b.get() << "\n";
  {
    Maybe<Noisy> n(Noisy(1));
    n.set(Noisy(2));
  }
  int* p = new int(5);
  int* q = new (p) int(7);
  std::cout << *p << " " << (p == q) << "\n";
  delete p;
  int* r = new (std::nothrow) int(9);
  std::cout << *r << "\n";
  delete r;
}
