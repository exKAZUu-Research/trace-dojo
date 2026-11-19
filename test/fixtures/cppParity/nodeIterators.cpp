#include <algorithm>
#include <iostream>
#include <list>
#include <map>
#include <set>

int* remembered;
void remember(int& n) { if (n == 2) remembered = &n; }

int main() {
  std::list<int> values{2, 1, 2, 3};
  auto first = std::find(values.begin(), values.end(), 2);
  std::for_each(values.begin(), values.end(), remember);
  auto last = values.end();
  int& original = *first;
  values.push_front(5);
  values.sort();
  int* saved = &original;
  std::cout << *first << ' ' << (&*first == saved) << ' ' << *remembered << ' ';
  values.reverse();
  values.remove(5);
  auto second = first;
  ++second;
  std::cout << *second << ' ' << (last == values.end()) << ' ';
  std::list<int> other{9};
  values.swap(other);
  std::cout << *first << ' ' << (&*first == saved) << ' ';
  for (auto it = other.begin(); it != other.end();) {
    if (*it == 2) other.erase(it++);
    else ++it;
  }
  for (auto value : other) std::cout << value;
  std::cout << ' ';

  std::set<int> keys{2, 3, 4};
  std::set<int>::const_iterator at;
  at = std::min_element(keys.begin(), keys.end());
  keys.insert(1);
  std::cout << *at << ' ';
  for (auto it = keys.begin(); it != keys.end();) {
    if (*it < 4) keys.erase(it++);
    else ++it;
  }
  for (int key : keys) std::cout << key;
  std::cout << ' ';

  std::map<int, int> numbers{{2, 7}, {3, 4}};
  auto entry = numbers.begin();
  numbers[1] = 5;
  numbers.erase(3);
  std::map<int, int> more;
  numbers.swap(more);
  std::cout << entry->first << entry->second;
}
