#include <algorithm>
#include <deque>
#include <iostream>
#include <iterator>
#include <queue>
#include <random>
#include <string>
#include <vector>

struct Empty {};
struct NestedEmpty : Empty {};
struct Direct : Empty { Empty member; };
struct Nested : Empty { NestedEmpty member; };
struct Scalar : Empty { int member; };
struct Item { int n; };

int main() {
  std::cout << sizeof(Direct) << sizeof(Nested) << sizeof(Scalar) << ' ';
  std::string text = "abc";
  std::cout << (&*text.begin() == text.data()) << (&text[1] - &*text.cbegin()) << ' ';
  int source[]{1, 2, 3};
  std::vector<int> target;
  std::copy(source, source + 3, std::back_inserter(target));
  std::cout << target.size() << target.capacity() << ' ';
  std::string targetText;
  std::copy(text.begin(), text.end(), std::back_inserter(targetText));
  std::cout << targetText << ' ';
  std::shuffle(target.begin(), target.end(), std::mt19937(4));
  for (int n : target) std::cout << n;
  double decimal[]{1.7, 2.2};
  int integral[2]{};
  std::copy(decimal, decimal + 2, integral);
  long long wide[]{1, 2};
  std::cout << ' ' << (std::equal(integral, integral + 2, wide)) << integral[0] << integral[1];
  Item items[]{{1}, {2}};
  int* first = &items[0].n;
  std::iter_swap(items, items + 1);
  std::cout << ' ' << *first;
  std::rotate(items, items + 1, items + 2);
  std::cout << *first;
  std::reverse(items, items + 2);
  std::cout << *first;
  std::deque<int> deque{1, 2};
  int& back = deque.back();
  deque.push_front(3);
  deque.pop_front();
  deque.pop_front();
  std::cout << ' ' << back;
  std::queue<int> queue;
  queue.push(1);
  queue.push(2);
  const int& last = queue.back();
  queue.pop();
  std::cout << last;
}
