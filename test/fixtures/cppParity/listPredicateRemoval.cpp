#include <iostream>
#include <list>

struct Item {
  int number;
  int id;
  Item(int number, int id) : number(number), id(id) {}
  ~Item() { std::cout << 'D' << id; }
};

std::list<Item>* active = nullptr;
const Item* removed = nullptr;
bool fails = false;

bool equivalent(const Item& first, const Item& next) {
  std::cout << active->size();
  if (next.number == 3) {
    std::cout << ':' << removed->id;
    if (fails) throw 1;
  }
  return first.number == next.number;
}

void check(bool shouldFail) {
  std::list<Item> values;
  values.emplace_back(1, 1);
  values.emplace_back(1, 2);
  values.emplace_back(2, 3);
  values.emplace_back(2, 4);
  values.emplace_back(3, 5);
  active = &values;
  auto survivor = values.begin();
  ++survivor;
  removed = &*survivor;
  ++survivor;
  fails = shouldFail;
  try {
    auto count = values.unique(equivalent);
    std::cout << '=' << count;
  } catch (int) {
    std::cout << 'E';
  }
  std::cout << ' ' << values.size() << ' ' << survivor->id << ' ';
  for (const Item& item : values) std::cout << item.number;
  std::cout << ' ';
}

int main() {
  check(false);
  std::cout << '\n';
  check(true);
  std::cout << '\n';
}
