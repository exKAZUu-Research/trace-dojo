#include <iostream>
#include <functional>
#include <vector>
#include <algorithm>
#include <string>
int twice(int x) { return 2 * x; }
struct Adder { int n; int operator()(int x) const { return x + n; } };
int main() {
  std::function<int(int)> f = twice;
  std::function<int(int)> g = [](int x) { return x * x; };
  std::function<int(int)> h = Adder{10};
  std::cout << f(3) << " " << g(4) << " " << h(5) << "\n";
  std::vector<std::function<int(int)>> fs{f, g, h};
  int total = 0;
  for (auto& fn : fs) total += fn(2);
  std::cout << total << "\n";
  std::function<void(const std::string&)> say = [](const std::string& s) { std::cout << "say " << s << "\n"; };
  say("hi");
  std::function<int(int)> empty;
  std::cout << static_cast<bool>(empty) << (empty == nullptr) << (f != nullptr) << "\n";
  try {
    empty(1);
  } catch (const std::bad_function_call& e) {
    std::cout << "caught " << e.what() << "\n";
  }
  int counter = 0;
  std::function<void()> inc = [&counter] { counter++; };
  inc();
  inc();
  std::cout << counter << " " << sizeof(f) << "\n";
  std::function<int(int, int)> cmp = [](int a, int b) { return a - b; };
  std::vector<int> v{3, 1, 2};
  std::function<bool(int, int)> less = [](int a, int b) { return a < b; };
  std::sort(v.begin(), v.end(), less);
  std::cout << v[0] << v[1] << v[2] << " " << cmp(5, 3) << "\n";
  std::function fib = [](int n) { return n * 2; };
  std::function<int(int)> rec = [&rec](int n) { return n <= 1 ? n : rec(n - 1) + rec(n - 2); };
  std::cout << fib(4) << " " << rec(10) << "\n";
  auto moved = std::move(g);
  std::cout << static_cast<bool>(g) << moved(3) << "\n";
}
