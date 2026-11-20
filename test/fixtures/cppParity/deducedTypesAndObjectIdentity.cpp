#include <iostream>
#include <vector>

struct Item {
  int width;
  int height = width + 1;
};
struct Tracked;
Tracked* current;
struct Tracked {
  Tracked() { current = this; }
  ~Tracked() { std::cout << (current == this); }
};
struct Base { ~Base(); };
struct Contains { Base member; };
Base::~Base() { std::cout << '!'; }

int fromGlobal = 4;
int measure(int n);
int measure(int n = fromGlobal);
int measure(int n) { return n; }

struct Stock {
  static const int count = 3;
  static int missing;
};

int main() {
  int fromGlobal = 9;
  auto* p = &fromGlobal, val = fromGlobal;
  const auto* view = p;
  auto* heap = new auto(7);
  Item item(2.5);
  std::vector<Item> items;
  items.emplace_back(5);
  {
    Tracked a[1];
    std::cout << (current == &a[0]);
  }
  Contains contains;
  std::cout << ' ' << measure() << *view << val << *heap << ' '
            << item.width << item.height << items[0].width << items[0].height
            << ' ' << Stock::count << sizeof(Stock::missing);
  delete heap;
}
