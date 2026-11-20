#include <iostream>
#include <string>
using namespace std;
void f(int x) { cout << "int " << x << endl; }
void f(double x) { cout << "double " << x << endl; }
void f(const string& s) { cout << "string " << s << endl; }
void f(char c) { cout << "char " << c << endl; }
void g(long x) { cout << "long " << x << endl; }
void g(double x) { cout << "double " << x << endl; }
void h(int& x) { cout << "ref" << endl; }
void h(const int& x) { cout << "cref" << endl; }
int area(int w, int h) { return w * h; }
int area(int s) { return s * s; }
class Box {
 public:
  Box() : w(1), h(1) { cout << "Box()" << endl; }
  Box(int s) : Box(s, s) { cout << "Box(int)" << endl; }
  Box(int w, int h) : w(w), h(h) { cout << "Box(int,int)" << endl; }
  int area() const { return w * h; }
  int area(int k) const { return k * w * h; }
 private:
  int w, h;
};
void takeBox(Box b) { cout << b.area() << endl; }
int main() {
  f(1); f(2.5); f("text"); f('c'); f(3.0f); f(true);
  g(5L); g(2.0f);
  int a = 1; const int b = 2; h(a); h(b); h(3);
  cout << area(3, 4) << " " << area(5) << endl;
  Box b1; Box b2(3); Box b3(2, 5); Box b4 = 7;
  cout << b1.area() << b2.area() << b3.area() << b4.area() << b3.area(2) << endl;
  takeBox(4);
  short sh = 3; f(sh);
}
