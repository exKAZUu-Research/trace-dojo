#include <iostream>
#include <string>
struct Counter {
  int count = 0;
  int base = 100;
  auto adder() { return [this](int n) { count += n; return base + count; }; }
  int run() {
    auto inc = [=]() { return count + 1; };
    auto twice = [&] { count *= 2; };
    twice();
    return inc();
  }
};
auto makeMultiplier(int k) { return [k](int x) { return x * k; }; }
int main() {
  int a = 3, b = 4;
  auto add = [](int x, int y) { return x + y; };
  std::cout << add(a, b) << "\n";
  auto byCopy = [a]() { return a * 10; };
  auto byRef = [&b]() { b += 1; return b; };
  a = 100;
  std::cout << byCopy() << " " << byRef() << " " << b << "\n";
  auto counter = [n = 0]() mutable { return ++n; };
  std::cout << counter() << counter() << counter() << "\n";
  std::string name = "abc";
  auto greet = [&, a](const std::string& s) -> std::string { return s + name + std::to_string(a); };
  std::cout << greet("hi ") << "\n";
  auto half = [](double d) { return d / 2; };
  std::cout << half(5) << "\n";
  auto times3 = makeMultiplier(3);
  std::cout << times3(7) << "\n";
  Counter c;
  auto f = c.adder();
  std::cout << f(5) << " " << f(2) << " " << c.count << " " << c.run() << "\n";
  const int K = 9;
  auto useK = [] { return K; };
  std::cout << useK() << "\n";
  auto nested = [a](int x) { return [a, x](int y) { return a + x + y; }; };
  std::cout << nested(1)(2) << "\n";
  [] { std::cout << "immediate\n"; }();
  auto noReturn = [&a]() { a = 5; };
  noReturn();
  std::cout << a << "\n";
}
