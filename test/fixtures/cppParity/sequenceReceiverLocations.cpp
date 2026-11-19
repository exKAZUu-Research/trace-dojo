#include <deque>
#include <iostream>
#include <list>
#include <vector>

struct Cell {
  Cell* self;
  int value;
  Cell(int n = 0) : self(this), value(n) {}
  Cell(const Cell& other) : self(this), value(other.value) {}
};

struct Counted;
Counted* first = nullptr;
struct Counted {
  Counted* self;
  Counted() : self(this) {
    if (first == nullptr) first = this;
    std::cout << this - first << ' ';
  }
};

struct Relocated;
Relocated* newest = nullptr;
struct Relocated {
  Relocated() { newest = this; }
  Relocated(const Relocated&) { std::cout << this - newest << '\n'; }
};

void show(Cell& cell, char separator = ' ') {
  std::cout << cell.self - &cell << ':' << cell.value << separator;
}

int main() {
  std::vector<Counted> contiguous(2);
  std::cout << contiguous[1].self - &contiguous[1] << '\n';
  std::vector<Counted> reserved;
  reserved.reserve(4);
  first = nullptr;
  reserved.emplace_back();
  reserved.emplace_back();
  std::cout << reserved[1].self - &reserved[1] << '\n';
  std::vector<Relocated> growing(1);
  growing.emplace_back();
  std::cout << newest - &growing.back() << '\n';

  std::vector<Cell> vector(1);
  std::deque<Cell> deque(1);
  std::list<Cell> list(1);
  show(vector.front());
  show(deque.front());
  show(list.front(), '\n');

  vector.reserve(4);
  vector.emplace_back(1);
  deque.emplace_front(2);
  list.emplace_back(3);
  list.reverse();
  show(vector.front());
  show(vector.back());
  show(deque.front());
  show(deque.back());
  show(list.front());
  show(list.back(), '\n');

  std::vector<Cell> copied(vector);
  std::deque<Cell> filled(2, deque.front());
  std::list<Cell> ranged(list.begin(), list.end());
  show(copied.back());
  show(filled.back());
  show(ranged.front(), '\n');
}
