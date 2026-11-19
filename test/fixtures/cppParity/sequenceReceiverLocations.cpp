#include <algorithm>
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

struct Inserted;
Inserted* firstInserted = nullptr;
struct Inserted {
  Inserted() {}
  Inserted(const Inserted&) {
    if (firstInserted == nullptr) firstInserted = this;
    std::cout << this - firstInserted;
  }
};

struct Probe;
Probe* observed = nullptr;
struct Probe {
  ~Probe() {
    if (observed != nullptr) {
      std::cout << (observed == this);
      observed = nullptr;
    }
  }
};

struct SelfBound {
  SelfBound* self;
  SelfBound* end;
  SelfBound() : self(this), end(this + 1) {}
  SelfBound(const SelfBound&) noexcept : self(this), end(this + 1) {}
};
struct Holder {
  SelfBound member;
  SelfBound matrix[2][2];
};
struct DerivedHolder : Holder {};
Holder returned(Holder input) { return input; }

void showMoved(Holder& holder) {
  auto& last = holder.matrix[1][1];
  std::cout << (holder.member.self - &holder.member) << ' '
            << (holder.member.end == &holder.member + 1) << ' '
            << (last.self - &last) << ' ' << (last.end == &last + 1) << '\n';
}

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

  std::list<int> nodes{1, 2};
  int* saved = &nodes.front();
  nodes.push_front(0);
  auto oldFirst = nodes.begin();
  ++oldFirst;
  int inputs[] = {3, 4};
  auto last = std::copy(inputs, inputs + 2, oldFirst);
  std::cout << (saved == &*oldFirst) << ' ' << ((saved + 1) - saved) << ' '
            << *saved << ' ' << (last == nodes.end()) << '\n';

  std::vector<Probe> vectorProbe(2);
  observed = &vectorProbe.back();
  vectorProbe.pop_back();
  observed = &vectorProbe.front();
  vectorProbe.clear();
  std::deque<Probe> dequeProbe(3);
  observed = &dequeProbe.back();
  dequeProbe.pop_back();
  observed = &dequeProbe.front();
  dequeProbe.pop_front();
  observed = &dequeProbe.front();
  dequeProbe.erase(dequeProbe.begin());
  std::list<Probe> listProbe(3);
  observed = &listProbe.back();
  listProbe.pop_back();
  observed = &listProbe.front();
  listProbe.erase(listProbe.begin());
  observed = &listProbe.front();
  listProbe.clear();
  std::cout << '\n';

  Holder sliced = DerivedHolder{};
  Holder result = returned(Holder{});
  std::vector<Holder> holders(1);
  holders.reserve(4);
  showMoved(sliced);
  showMoved(result);
  showMoved(holders.front());

  Inserted seed;
  std::vector<Inserted> counted;
  counted.reserve(4);
  counted.insert(counted.end(), 2, seed);
  std::cout << ' ' << (firstInserted == &counted.front()) << '\n';
  Inserted input[2];
  firstInserted = nullptr;
  std::vector<Inserted> range;
  range.reserve(4);
  range.insert(range.end(), input, input + 2);
  std::cout << ' ' << (firstInserted == &range.front()) << '\n';
}
