#include <iostream>
#include <string>
struct Name { operator std::string() const { return "conv"; } };
int main() { Name n; std::string a = n; std::string b(n); std::string c{n}; std::cout << a << b << c << "\n"; }
