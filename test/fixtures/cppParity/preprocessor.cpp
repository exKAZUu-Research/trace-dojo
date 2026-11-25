#include <iostream>
#include <cmath>
#define N 5
#define SQUARE(x) ((x) * (x))
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define STR(x) #x
#define CAT(a, b) a##b
#define LOG(fmt, ...) std::printf(fmt __VA_OPT__(,) __VA_ARGS__)
#define DEBUG
#define VERSION 3
#define LONG_MACRO(a, b) \
  ((a) + \
   (b))
#ifdef DEBUG
const char* mode = "debug";
#else
const char* mode = "release";
#endif
#if VERSION >= 3 && defined(N)
int level = 3;
#elif VERSION == 2
int level = 2;
#else
int level = 1;
#endif
#ifndef M_PI
#error no pi
#endif
#undef VERSION
#if defined(VERSION)
int bad = 1;
#endif
int main() {
  int CAT(my, Var) = N;
  int arr[N] = {};
  std::cout << SQUARE(N + 1) << " " << MAX(3, 7) << " " << STR(hello world) << " " << myVar << " " << sizeof(arr) / sizeof(int) << "\n";
  std::cout << mode << level << " " << LONG_MACRO(1, 2) << " " << __LINE__ << " " << __cplusplus << "\n";
  LOG("%d\n", 42);
  LOG("plain\n");
  /* comment with N inside
     still comment N */
  std::cout << N /* inline N */ << "\n";
#if __has_include(<vector>)
  std::cout << "has vector\n";
#endif
}
