#include <iostream>
#include <cstdlib>
#include <string>
struct S { std::string n; S(std::string n) : n(n) { std::cout << "S" << n << " "; } ~S() { std::cout << "~S" << n << " "; } };
struct C { int x; double d; int a[2]; };
struct U { int x; int y; U() : y(5) {} };
S g1("1");
C gc;
C arr[2];
U gu;
static S g2("2");
struct M { static S m; };
S M::m("m");
void f() { static S local("L"); static int count; count++; std::cout << count << " "; }
int main(int argc, char* argv[]) {
  std::cout << gc.x << gc.d << gc.a[1] << arr[1].x << gu.x << gu.y << " ";
  f(); f();
  static C sc; std::cout << sc.x << " ";
  if (argc > 0) std::exit(0);
  std::cout << "end ";
}
