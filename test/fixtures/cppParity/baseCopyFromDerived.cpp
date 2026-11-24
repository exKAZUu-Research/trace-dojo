#include <cstdio>
struct Base {
  int v;
  Base(int x) : v(x) {}
};
struct Derived : Base {
  int w;
  Derived(int a) : Base(a), w(a) {}
  Derived(const Derived& o) : Base(o), w(o.w) {}
};
template <class T>
struct Holder {
  Holder() = default;
  template <class U>
  Holder(const Holder<U>&) {}
};
struct Wrapped : private Holder<int> {
  Wrapped() {}
  Wrapped(const Wrapped& o) : Holder<int>(o) {}
};
int main() {
  Derived d(3);
  Derived e(d);
  Base b(d);
  Wrapped w;
  Wrapped x(w);
  printf("%d %d %d\n", e.v, e.w, b.v);
}
