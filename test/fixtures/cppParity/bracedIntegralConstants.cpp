#include <iostream>

struct Sizes {
  static const int count{3};
  static const int empty{};
  static const unsigned long capacity = {4};
  static constexpr int more{count + 1};
};

struct Defined { static const int n; };
const int Defined::n{5};
const int fileScope{2};

int main() {
  int a[Sizes::count]{};
  int b[Defined::n]{};
  static const int localStatic{6};
  const int local{7};
  int c[fileScope + localStatic + local]{};
  std::cout << Sizes::count + 1 << ' ' << Sizes::empty + 0 << ' ' << Sizes::capacity + 0 << ' ' << Sizes::more + 0
            << '\n' << sizeof(a) + sizeof(b) + sizeof(c) << '\n';
}
