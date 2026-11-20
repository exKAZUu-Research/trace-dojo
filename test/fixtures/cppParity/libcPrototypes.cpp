#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
using namespace std;

int abs(int);
int rand(void);
int puts(const char*);
int toupper(int);
size_t strlen(const char*);
int atoi(const char*);

int main() {
  std::srand(1);
  int first = ::rand();
  std::srand(1);
  std::cout << abs(-3) << std::abs(-4) << (first == std::rand()) << ' '
            << toupper('a') << std::toupper('b') << ' '
            << strlen("abc") << std::strlen("defg") << ' '
            << atoi("abc") << std::atoi("abc") << '\n';
  puts("prototype");
}

int atoi(const char*) { return 9; }
