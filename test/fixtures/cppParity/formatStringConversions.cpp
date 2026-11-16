#include <cstdio>
#include <iostream>
#include <stdexcept>
#include <string>
using namespace std;
int main() {
  for (const char* text : {"1e-310", "1e-40", "0x1p-1074", "0x1p-149", "1e-320", "2e-308", "1e39"}) {
    try {
      cout << stod(text) << ' ';
    } catch (const out_of_range& e) {
      cout << e.what() << ' ';
    }
    try {
      cout << stof(text) << ' ';
    } catch (const out_of_range& e) {
      cout << e.what() << ' ';
    }
    try {
      cout << stold(text) << '\n';
    } catch (const out_of_range& e) {
      cout << e.what() << '\n';
    }
  }

  string s = "abc";
  const char* before = s.c_str();
  cout << (s.c_str() == s.data()) << (before == s.c_str()) << '\n';
  cout.flush();

  int a = puts("x");
  int b = fputs("yz\n", stdout);
  int c = puts("");
  int d = fputs("", stdout);
  int e = fputs("abcdefghijkl\n", stdout);
  printf("%d %d %d %d %d\n", a, b, c, d, e);
}
