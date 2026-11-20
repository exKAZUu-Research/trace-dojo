#include <cmath>
#include <cstdlib>
#include <cstring>
#include <iostream>
using namespace std;

int abs(int value) { return value < 0 ? -value : value; }
double sqrt(double value) { return value == 9.0 ? 3.0 : 2.0; }
size_t strlen(const char* value) { return value[0] == 'a' ? 7 : 8; }
int main() {
  char text[] = "abc";
  std::cout << abs(-3) << ' ' << std::abs(-4) << ' ' << abs(-5L) << ' '
            << sqrt(9.0) << ' ' << std::sqrt(4.0) << ' ' << strlen(text) << ' ' << std::strlen(text) << '\n';
}
