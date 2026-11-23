#include <iostream>

struct Point { int x; int y; };
int read(const Point& point = {3, 4}) { return point.x + point.y; }
int take(Point point = {}) { return point.x + point.y; }
int choose(int value = {}) { return value; }

int main() {
  std::cout << read() << take() << choose() << read({1, 2}) << take({9, 8}) << '\n';
}
