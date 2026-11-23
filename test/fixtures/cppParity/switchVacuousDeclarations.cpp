#include <array>
#include <cstddef>
#include <iostream>

struct Base { int x; };
struct Item : Base { int y; };

int main() {
  switch (1) {
    int a;
    case 0:
      int b[2];
      std::size_t count;
      Item item, items[2];
      std::array<int, 2> values;
    case 1:
      a = 2;
      b[0] = 3;
      count = 3;
      item.x = 4;
      items[1].y = 5;
      values[0] = 6;
      std::cout << a + b[0] << ' ' << count << item.x << items[1].y << values[0] << '\n';
  }
}
