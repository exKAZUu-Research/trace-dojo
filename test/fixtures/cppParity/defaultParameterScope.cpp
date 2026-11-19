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

int joined(int first, int second = 2);
int joined(int first = 1, int second);
int joined(int first, int second) { return 10 * first + second; }

struct Member {
  int value;
  Member(int base, int scale);
  static int choose(int first, int second = 4);
};

Member::Member(int base, int scale = 3) : value(base * scale) {}
int Member::choose(int first = 2, int second) { return 10 * first + second; }

int main() {
  std::cout << f(2) << ' ' << g() << ' ' << Shape(2).width << '\n';
  Dimensions dimensions;
  std::cout << dimensions.width << ' ' << Dimensions::elementSize() << ' ' << sizeof(Shape::width) << '\n';
  std::cout << joined() << ' ' << Member::choose() << ' ' << Member(5).value << '\n';
}
