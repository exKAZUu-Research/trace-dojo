#include <iostream>
#include <string>
int g = 1;
int& get() { return g; }
int* ptr(int* a, int i) { return a + i; }
const std::string& longer(const std::string& a, const std::string& b) { return a.size() >= b.size() ? a : b; }
int& pick(int& a, int& b);
struct S { int v = 3; int& ref(); const int* cp() const; };
int& S::ref() { return v; }
const int* S::cp() const { return &v; }
int& pick(int& a, int& b) { return a > b ? a : b; }
struct T { int id; T(int i) : id(i) { std::cout << "C" << id << " "; } ~T() { std::cout << "D" << id << " "; } };
struct B { virtual ~B() { std::cout << "~B "; } };
struct Dd : B { ~Dd() { std::cout << "~Dd "; } };
int twice(int x) { return x * 2; }
std::string make() { return "made"; }
void temporaries() {
  const int& i = 4;
  int v = 3; const long& l = v; v = 9;
  const int& r = twice(5);
  const std::string& s = "abc";
  const std::string& m = make();
  const double& d = v;
  const T& t = T(1);
  const B& b = Dd();
  std::cout << i << l << r << s << m << d << t.id << " ";
}
int main() {
  get() = 5; int arr[3] = {1, 2, 3}; *ptr(arr, 1) = 9;
  int x = 4, y = 7; pick(x, y) = 0;
  S s; s.ref() = 8;
  std::cout << g << arr[1] << longer("ab", "abc") << x << y << *s.cp() << std::endl;
  temporaries();
  std::cout << std::endl;
}
