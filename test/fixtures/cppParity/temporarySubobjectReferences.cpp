#include <iostream>

struct Matrix {
  int entries[2][2] = {{1, 2}, {3, 4}};
  ~Matrix() { std::cout << "matrix\n"; }
};

struct Left {
  int value = 5;
  ~Left() { std::cout << "left\n"; }
};

struct Right {
  int value = 6;
  ~Right() { std::cout << "right\n"; }
};

int position() {
  std::cout << "index\n";
  return 1;
}

bool choice() {
  std::cout << "choose\n";
  return false;
}

int throwingIndex() { throw 1; }

void staticReference() {
  static const int& saved = Matrix{}.entries[position()][0];
  std::cout << saved << '\n';
}

int main() {
  {
    const int& entry = position()[Matrix{}.entries][0];
    const int& selected = choice() ? Left{}.value : Right{}.value;
    const int& comma = (position(), Left{}.value);
    std::cout << entry << selected << comma << '\n';
  }
  int original = 7;
  const int& mixed = true ? original : Left{}.value;
  original = 8;
  std::cout << mixed << '\n';
  try {
    const int& entry = Matrix{}.entries[throwingIndex()][0];
    std::cout << entry << '\n';
  } catch (int) {
    std::cout << "caught\n";
  }
  staticReference();
  staticReference();
}
