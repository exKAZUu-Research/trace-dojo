#include <deque>
#include <iostream>

void afterClear(int initial, int refill, int offset) {
  std::deque<int> values(initial, 9);
  values.clear();
  values.resize(refill, 7);
  int* first = &values.front();
  std::cout << first[offset] << '\n';
}

int main() {
  afterClear(900, 300, 200);
  afterClear(1400, 900, 700);

  std::deque<int> resized(900, 9);
  resized.resize(0);
  resized.resize(300, 7);
  int* first = &resized.front();
  std::cout << first[200] << '\n';

  std::deque<int> popped(1024, 9);
  while (!popped.empty()) popped.pop_back();
  popped.resize(1024, 7);
  first = &popped.front();
  std::cout << first[1023] << '\n';
}
