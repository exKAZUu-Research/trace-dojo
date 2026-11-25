#include <iostream>
#include <string>
using namespace std::string_literals;
long double operator""_km(long double x) { return x * 1000; }
unsigned long long operator""_kb(unsigned long long x) { return x * 1024; }
std::string operator""_shout(const char* s, std::size_t n) { return std::string(s, n) + "!"; }
int operator""_len(const char* digits) { return std::string(digits).size(); }
int main() {
  std::cout << R"(C:\dir\n)" << "\n" << R"x(a"b)x" << R"(multi
line)" << "\n";
  auto s = "hello"s;
  std::cout << s.size() << s + " world"s << "\n";
  std::cout << 1.5_km << " " << 2_kb << " " << "hey"_shout << " " << 12345_len << "\n";
}
