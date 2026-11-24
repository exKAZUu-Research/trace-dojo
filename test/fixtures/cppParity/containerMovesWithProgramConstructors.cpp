#include <cstdio>
#include <vector>
#include <utility>
struct N {
  int v;
  N(int x) : v(x) { printf("make %d\n", v); }
  N(const N& o) : v(o.v) { printf("copy %d\n", v); }
  N(N&& o) noexcept : v(o.v) { o.v = -1; printf("move %d\n", v); }
  N& operator=(N&& o) noexcept { v = o.v; o.v = -1; printf("mvassign %d\n", v); return *this; }
  N& operator=(const N& o) { v = o.v; printf("cpassign %d\n", v); return *this; }
  ~N() { printf("drop %d\n", v); }
};
int main() {
  std::vector<N> v;
  v.reserve(1);
  v.push_back(N(1));
  v.emplace_back(2);
  N n(3);
  v.push_back(std::move(n));
  v.erase(v.begin());
  std::swap(v[0], v[1]);
  printf("end\n");
}
