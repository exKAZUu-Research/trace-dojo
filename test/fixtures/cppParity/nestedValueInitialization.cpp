#include <array>
#include <iostream>

struct Member {
  int n;
  Member() { std::cout << n; }
};

struct Owner {
  Member member;
  Member members[2];
  std::array<Member, 2> array;
};

struct ThroughBase : Owner {
  ThroughBase() : Owner() {}
};

int main() {
  auto owner = Owner();
  std::cout << '|';
  ThroughBase throughBase;
  std::cout << '\n';
}
