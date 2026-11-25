#include <iostream>
enum Color { RED, GREEN = 5, BLUE };
enum class Dir : char { N = 'n', E, S, W };
enum Big { HUGE_V = 5000000000 };
struct Shape {
  enum Kind { CIRCLE, SQUARE };
  Kind kind = SQUARE;
};
void show(int x) { std::cout << "int " << x << "\n"; }
void show(Color c) { std::cout << "Color " << static_cast<int>(c) << "\n"; }
void show(Dir d) { std::cout << "Dir " << static_cast<char>(d) << "\n"; }
int main() {
  Color c = BLUE;
  std::cout << c << " " << RED + 1 << " " << sizeof(Color) << " " << sizeof(Dir) << " " << sizeof(Big) << "\n";
  Dir d = Dir::E;
  if (d == Dir::E) std::cout << "east\n";
  std::cout << (Dir::N < Dir::W) << "\n";
  show(c);
  show(d);
  show(GREEN + 0);
  Shape s;
  std::cout << s.kind << " " << Shape::CIRCLE << "\n";
  switch (d) {
    case Dir::N: std::cout << "N\n"; break;
    case Dir::E: std::cout << "E\n"; break;
    default: break;
  }
  enum Local { X = -3, Y };
  Local l = Y;
  std::cout << l << " " << static_cast<Color>(1) << "\n";
  int n = c;
  std::cout << n << " " << Color::GREEN << " " << HUGE_V << "\n";
  Dir e = static_cast<Dir>(115);
  std::cout << (e == Dir::S) << "\n";
}
