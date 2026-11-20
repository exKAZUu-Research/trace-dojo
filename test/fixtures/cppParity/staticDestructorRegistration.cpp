#include <iostream>

struct Log {
  char value;
  ~Log() { std::cout << value; }
};

char read();
char initial = read();
char build(char value) { return value; }
Log first{build('A')};
Log constant{'B'};
Log last{build('C')};
char read() { return constant.value; }

void local(bool enter) {
  if (enter) {
    static Log entered{'L'};
  } else {
    static Log unused{'U'};
  }
}

int main() {
  std::cout << initial << ':';
  local(true);
  local(true);
}
