#include <array>
#include <iostream>

struct Cell {
  Cell* self;
  Cell* next;
  int value;
  Cell(int n = 7) : self(this), next(this + 1), value(n) {}
  Cell(const Cell& source) : self(this), next(this + 1), value(source.value) {}
  ~Cell() { if (self != this) std::cout << "lost address\n"; }
};

Cell globalCells[2];

void show(Cell* cells) {
  std::cout << (cells[0].next == &cells[1]) << ' ' << cells[0].next->value << ' '
            << (cells[1].self - cells) << ' ' << (cells[1].next == cells + 2) << '\n';
}

int main() {
  show(globalCells);
  Cell direct[2] = {Cell(1), Cell(2)};
  show(direct);
  Cell copied[2] = {direct[0], direct[1]};
  show(copied);
  Cell* dynamic = new Cell[2]();
  show(dynamic);
  delete[] dynamic;
  Cell* listed = new Cell[2]{Cell(3), Cell(4)};
  show(listed);
  delete[] listed;
  std::array<Cell, 2> stored{};
  show(stored.data());
  std::array<Cell, 2> list{Cell(5), Cell(6)};
  show(list.begin());
  std::array<Cell, 2> copy = list;
  show(copy.data());
}
