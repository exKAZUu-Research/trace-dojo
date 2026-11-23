#include <deque>
#include <iostream>

int copies = 0;
struct Entry {
  int value;
  Entry(int number) : value(number) {}
  Entry(const Entry& other) : value(other.value) {
    if (++copies == 3) throw value;
  }
};

int main() {
  Entry fill(2);
  std::deque<Entry> front;
  front.emplace_back(9);
  try {
    front.insert(front.begin(), 4, fill);
  } catch (int value) {
    std::cout << value << ' ' << front.size() << ' ';
    for (const Entry& item : front) std::cout << item.value;
    std::cout << '\n';
  }

  copies = 0;
  Entry source[] = {1, 2, 3, 4};
  std::deque<Entry> back;
  back.emplace_back(9);
  try {
    back.insert(back.end(), source, source + 4);
  } catch (int value) {
    std::cout << value << ' ' << back.size() << ' ';
    for (const Entry& item : back) std::cout << item.value;
    std::cout << '\n';
  }
}
