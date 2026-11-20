#include <iostream>
#include <string>
#include <algorithm>
using std::cout;
using std::endl;
int counter() { static int n = 0; return ++n; }
int global = 10;
const double RATE = 1.5;
void increment(int&);
void increment(int& x) { x++; }
class Shape {
 public:
  Shape(std::string name) : name(name) {}
  virtual ~Shape() {}
  virtual double area() const = 0;
  void describe() const { cout << name << " " << area() << endl; }
  static int created;
  static int count() { return created; }
 protected:
  std::string name;
};
int Shape::created = 0;
class Rect : public Shape {
 public:
  Rect(double w, double h) : Shape("rect"), w(w), h(h) { created++; }
  double area() const override { return w * h; }
 protected:
  double w, h;
};
class Square final : public Rect {
 public:
  Square(double s) : Rect(s, s) { name = "square"; }
  double area() const override { return Rect::area(); }
};
int main() {
  cout << counter() << counter() << counter() << endl;
  int a = 0x1F, b = 0b101, c = 017, d = 1'000'000; unsigned long e = 10ul; long long f = 5LL;
  cout << a << " " << b << " " << c << " " << d << " " << e << " " << f << " " << 1.5e2 << " " << 2.f << endl;
  cout << "tab\tnew\\line \"q\" " << 'x' << '\'' << " " << "con" "cat" << endl;
  int i = (a++, b++, a + b); cout << i << endl;
  double ratio = (double)a / b; cout << ratio << " " << int(ratio) << " " << static_cast<int>(RATE * 2) << endl;
  cout << sizeof a << " " << sizeof(double) << " " << sizeof(Shape*) << endl;
  int arr[] = {3, 1, 2};
  for (int x : arr) cout << x; cout << endl;
  for (int x : {7, 8, 9}) cout << x; cout << endl;
  int k = 0; do { k += 2; } while (k < 5); cout << k << endl;
  increment(global); cout << global << endl;
  Shape* shapes[2] = {new Rect(2, 3), new Square(4)};
  for (Shape* s : shapes) s->describe();
  cout << Shape::count() << " " << Shape::created << endl;
  for (Shape* s : shapes) delete s;
  int* p = (int*)nullptr; cout << (p == nullptr) << endl;
  cout << std::max<int>(3, 9) << " " << std::min(2.5, 1.5) << endl;
  bool flag = !(a > b) || (a == b && b != 0); cout << flag << endl;
  int x = 5; x <<= 2; x >>= 1; x |= 1; x &= 7; x ^= 2; cout << x << endl;
  char grade = 'B';
  switch (grade) { case 'A': case 'B': cout << "good"; break; default: cout << "other"; }
  cout << endl;
  try { throw std::string("str"); } catch (const std::string& s) { cout << s << endl; } catch (...) { cout << "?" << endl; }
  try { throw 3.5; } catch (int) { cout << "int" << endl; } catch (...) { cout << "any" << endl; }
  std::string names[] = {"b", "a"};
  std::sort(names, names + 2);
  cout << names[0] << names[1] << endl;
}
