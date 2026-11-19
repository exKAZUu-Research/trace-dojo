#include <iostream>

class Record;
struct Record { int number; };

struct Base { int number; };
class Public;
struct Public : Base {};

int main() {
  Record record{7};
  Public derived{{9}};
  const Base& base = derived;
  std::cout << record.number << ' ' << base.number << '\n';
}
