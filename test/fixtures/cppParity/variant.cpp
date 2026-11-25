#include <iostream>
#include <variant>
#include <string>
#include <vector>
struct Printer {
  void operator()(int i) const { std::cout << "int " << i << "\n"; }
  void operator()(double d) const { std::cout << "double " << d << "\n"; }
  void operator()(const std::string& s) const { std::cout << "string " << s << "\n"; }
};
int main() {
  std::variant<int, double, std::string> v = 3;
  std::cout << v.index() << " " << std::get<int>(v) << " " << std::holds_alternative<int>(v) << " " << sizeof(v) << "\n";
  v = 2.5;
  std::cout << v.index() << " " << std::get<1>(v) << "\n";
  v = "text";
  std::cout << v.index() << " " << std::get<std::string>(v) << "\n";
  std::visit(Printer{}, v);
  std::vector<std::variant<int, std::string>> items{1, std::string("two"), 3};
  for (const auto& item : items) std::visit([](const auto& x) { std::cout << x << ";"; }, item);
  std::cout << "\n";
  try {
    std::get<int>(v);
  } catch (const std::bad_variant_access& e) {
    std::cout << "bad " << e.what() << "\n";
  }
  if (auto* p = std::get_if<std::string>(&v)) std::cout << "has " << *p << "\n";
  std::cout << (std::get_if<int>(&v) == nullptr) << "\n";
  std::variant<std::monostate, int> empty;
  std::cout << empty.index() << " " << std::holds_alternative<std::monostate>(empty) << "\n";
  std::variant<int, std::string> a = 5, b = 5, c = std::string("x");
  std::cout << (a == b) << (a != c) << (a < c) << "\n";
  auto len = std::visit([](const auto& x) -> int { return sizeof(x); }, c);
  std::cout << len << " " << std::variant_size_v<decltype(c)> << "\n";
  v.emplace<std::string>("again");
  std::cout << std::get<2>(v) << "\n";
}
