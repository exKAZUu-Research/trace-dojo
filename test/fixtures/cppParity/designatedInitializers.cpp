#include <iostream>
#include <string>
struct P { int x = 7; int y; };
struct Q { P p; int z; std::string name = "q"; };
int main() {
  P a{.x = 1, .y = 2};
  P b{.y = 5};
  P c{.y = 2, .x = 1};
  Q q{.p.x = 3, .z = 4};
  Q r{.p = {.y = 4}, .name = "r"};
  int arr[5] = {[1] = 5, [3] = 7};
  int big[] = {[4] = 1};
  int range[6] = {[1 ... 3] = 9};
  int mixed[4] = {[2] = 1, 8};
  std::cout << a.x << a.y << b.x << b.y << c.x << c.y << " " << q.p.x << q.p.y << q.z << q.name << " " << r.p.x << r.p.y << r.z << r.name << "\n";
  for (int v : arr) std::cout << v;
  std::cout << sizeof(big) << " " << range[2] << range[4] << mixed[3] << "\n";
}
