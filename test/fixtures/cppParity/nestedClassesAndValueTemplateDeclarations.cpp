#include <cstdio>
template <int N>
struct Grid {
  int cells[N] = {};
  int size() const { return N; }
};
class List {
public:
  class Cursor {
    List* list;
    int at;

  public:
    Cursor(List* l, int i) : list(l), at(i) {}
    int value() const { return list->get(at); }
    bool done() const { return at >= list->count(); }
    void next() { ++at; }
  };
  Cursor begin() { return Cursor(this, 0); }
  int get(int i) const { return items[i]; }
  int count() const { return n; }
  void add(int v) { items[n++] = v; }

private:
  int items[8] = {};
  int n = 0;
};
int main() {
  Grid<3> g, h;
  Grid<4> four{};
  g.cells[1] = 5;
  printf("%d %d %d %d\n", g.size(), g.cells[1], h.cells[1], four.size());
  List list;
  list.add(3);
  list.add(4);
  for (List::Cursor c = list.begin(); !c.done(); c.next()) printf("%d ", c.value());
  printf("\n");
}
