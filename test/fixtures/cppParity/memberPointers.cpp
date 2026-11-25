#include <cstdio>
struct P {
  int x = 1, y = 2;
  int sum() const { return x + y; }
  int scale(int k) { return k * x; }
  virtual int id() const { return 0; }
};
struct Q : P { int id() const override { return 1; } };
int apply(const P& p, int (P::*f)() const) { return (p.*f)(); }
int main() {
  P p;
  int P::*m = &P::y;
  p.*m = 5;
  P* q = &p;
  q->*m += 1;
  int (P::*f)() const = &P::sum;
  int (P::*g)(int) = &P::scale;
  using Getter = int (P::*)() const;
  Getter h = &P::id;
  Q qq;
  printf("%d %d %d %d %d %d\n", p.y, p.*m, (p.*f)(), (q->*g)(3), (qq.*h)(), apply(p, &P::sum));
  printf("%d %d\n", m == &P::y, m != nullptr);
  int P::*none = nullptr;
  printf("%d %zu %zu\n", none == nullptr, sizeof(m), sizeof(f));
}
