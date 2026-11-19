#include <iostream>

char n = 'g';
int later = 19;

int f(long long n, int width = sizeof(n), int outer = sizeof(::n)) {
  return width * 10 + outer;
}

int g(int value = later, int later = 3) { return value + later; }

struct Shape {
  inline static char n = 's';
  int width;
  Shape(long n, int size = sizeof(n), int outer = sizeof(Shape::n)) : width(size * 10 + outer) {}
};

class Dimensions {
  long fields[2];
public:
  int width;
  Dimensions(int size = sizeof(fields)) : width(size) {}
  static int elementSize() { return sizeof(fields[0]); }
};

int main() {
  std::cout << f(2) << ' ' << g() << ' ' << Shape(2).width << '\n';
  Dimensions dimensions;
  std::cout << dimensions.width << ' ' << Dimensions::elementSize() << ' ' << sizeof(Shape::width) << '\n';
}
