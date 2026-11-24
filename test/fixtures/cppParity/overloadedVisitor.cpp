#include <iostream>
#include <variant>
#include <string>
template <class... Ts> struct overloaded : Ts... { using Ts::operator()...; };
template <class... Ts> overloaded(Ts...) -> overloaded<Ts...>;
int main() {
  std::variant<int, std::string> v = std::string("hi");
  std::visit(overloaded{[](int i) { std::cout << "int " << i << "\n"; },
                        [](const std::string& s) { std::cout << "str " << s << "\n"; }},
             v);
  v = 4;
  std::visit(overloaded{[](int i) { std::cout << "int " << i << "\n"; },
                        [](const std::string& s) { std::cout << "str " << s << "\n"; }},
             v);
}
