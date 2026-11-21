#include <algorithm>
#include <iostream>

int read();
int early = read();
int calls = 0;
int next() { return ++calls; }
int shared = 6;

struct Reference {
  const int& n = {7};
};
Reference bound{9};
Reference defaultBound{};

struct Configuration {
  int start = 3;
  int increment = std::max(this->start + 1, -1);
  const int& alias = increment;
  long finish = alias > 4 ? (alias << 1) + 1 : -alias;
  bool ready = (start && finish) || next();
};
Configuration defaults{};
Configuration supplied{7};

struct Dynamic {
  int value = next();
  int copy = value + 1;
};
Dynamic dynamic{};

struct Direct {
  int& value;
};
Direct direct{shared};

int read() {
  return bound.n + defaultBound.n + defaults.finish + supplied.finish
      + defaults.ready + supplied.ready + dynamic.copy + direct.value;
}

int main() {
  std::cout << early << ':' << read() << ':' << calls << '\n';
}
