#include <iostream>

int destroyed = 0;

struct Cell {
  Cell* self;
  Cell* end;
  int id;
  Cell(int id = 1) : self(this), end(this + 1), id(id) {}
  Cell(const Cell& source) : self(this), end(this + 1), id(source.id) {}
  ~Cell() { destroyed += id; }
};

struct Holder { Cell value; };
Cell global{2};

Cell makeCell() { return Cell(3); }

void show(const Cell& cell) {
  std::cout << cell.self - &cell << ' ' << (cell.end == &cell + 1) << '\n';
}

void byValue(Cell cell) { show(cell); }

int main() {
  show(global);
  Cell plain;
  Cell parenthesized(4);
  Holder holder;
  Cell returned = makeCell();
  const Cell& temporary = Cell(5);
  show(plain);
  show(parenthesized);
  show(holder.value);
  show(returned);
  show(temporary);
  Cell* defaultAllocation = new Cell;
  Cell* explicitAllocation = new Cell{6};
  show(*defaultAllocation);
  show(*explicitAllocation);
  delete defaultAllocation->self;
  delete explicitAllocation->self;
  std::cout << destroyed << '\n';
  byValue(Cell(7));
  Cell source[] = {Cell(8), Cell(9)};
  for (Cell value : source) show(value);
  try { throw Cell(10); }
  catch (Cell value) { show(value); }
  try { throw Cell(11); }
  catch (const Cell& value) { show(value); }
}
