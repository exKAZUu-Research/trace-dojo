#include <iostream>
#include <vector>

struct Holder { std::vector<int> values; };
Holder empty() { return Holder{}; }

struct Derived : Holder {};
struct WithDestructor {
  std::vector<int> values;
  ~WithDestructor() {}
};
struct WithCopy {
  std::vector<int> values;
  WithCopy() {}
  WithCopy(const WithCopy& source) : values(source.values) {}
};

int main() {
  Holder holder;
  holder.values.reserve(10);
  holder.values.push_back(1);
  holder = Holder{};
  std::cout << holder.values.size() << ' ' << holder.values.capacity() << '\n';
  holder.values.reserve(10);
  holder = empty();
  std::cout << holder.values.capacity() << '\n';
  holder.values.reserve(10);
  const Holder source{};
  holder = source;
  std::cout << holder.values.capacity() << '\n';

  Derived derived;
  derived.values.reserve(10);
  derived = Derived{};
  std::cout << derived.values.capacity() << '\n';

  WithDestructor first;
  first.values.reserve(10);
  first = WithDestructor{};
  WithCopy second;
  second.values.reserve(10);
  second = WithCopy{};
  std::cout << first.values.capacity() << ' ' << second.values.capacity() << '\n';
}
