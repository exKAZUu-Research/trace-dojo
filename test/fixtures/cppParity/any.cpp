#include <iostream>
#include <any>
#include <string>
#include <vector>
int main() {
  std::any a = 1;
  std::cout << a.has_value() << " " << std::any_cast<int>(a) << " " << a.type().name() << " " << sizeof(a) << "\n";
  a = std::string("text");
  std::cout << std::any_cast<std::string>(a) << " " << (a.type() == typeid(std::string)) << "\n";
  try {
    std::any_cast<int>(a);
  } catch (const std::bad_any_cast& e) {
    std::cout << "bad: " << e.what() << "\n";
  }
  if (auto* p = std::any_cast<std::string>(&a)) std::cout << "len " << p->size() << "\n";
  std::cout << (std::any_cast<double>(&a) == nullptr) << "\n";
  std::vector<std::any> items{1, 2.5, std::string("s"), 'c'};
  for (const auto& item : items) std::cout << item.type().name() << " ";
  std::cout << "\n";
  std::any b = a;
  a.reset();
  std::cout << a.has_value() << b.has_value() << " " << a.type().name() << "\n";
  auto m = std::make_any<std::vector<int>>(3, 7);
  std::cout << std::any_cast<std::vector<int>&>(m).size() << "\n";
  int& ref = std::any_cast<int&>(items[0]);
  ref = 42;
  std::cout << std::any_cast<int>(items[0]) << "\n";
}
