#include <cstdio>
template <unsigned long... I> struct Seq {};
template <unsigned long N, unsigned long... I> struct Make : Make<N - 1, N - 1, I...> {};
template <unsigned long... I> struct Make<0, I...> { using type = Seq<I...>; };
template <class F, unsigned long... I> void each(F f, Seq<I...>) { (f(I), ...); }
template <class... T> struct Tup;
template <> struct Tup<> {};
template <class H, class... R> struct Tup<H, R...> : Tup<R...> {
  H head;
  Tup() = default;
  Tup(const H& h, const R&... r) : Tup<R...>(r...), head(h) {}
};
template <unsigned long I> struct At {
  template <class H, class... R> static auto& get(Tup<H, R...>& t) { return At<I - 1>::get(static_cast<Tup<R...>&>(t)); }
};
template <> struct At<0> {
  template <class H, class... R> static H& get(Tup<H, R...>& t) { return t.head; }
};
int main() {
  each([](unsigned long i) { printf("%lu ", i); }, Make<4>::type{});
  Tup<int, double, char> t(1, 2.5, 'c');
  printf("\n%d %g %c %zu\n", At<0>::get(t), At<1>::get(t), At<2>::get(t), sizeof(t));
}
