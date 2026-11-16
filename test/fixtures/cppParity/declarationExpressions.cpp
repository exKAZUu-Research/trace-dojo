#include <cstddef>
#include <iostream>

struct T {
  int v;
  T(int x) : v(x) { std::cout << "T(" << x << ") "; }
};
struct Node {
  Node* next;
  int v;
};

int g = sizeof(g);
void* gq = &gq;
Node self = {&self, 4};
T global(7);
int k = 3;
int gi(k);
int a[5];

void f(int i) {
  static int n(i);
  static T s(i);
  static void* sp = &sp;
  std::cout << n << s.v << (sp == &sp) << '\n';
}

int idx() {
  std::cout << "idx ";
  return 1;
}

int val() {
  std::cout << "val ";
  return 7;
}

int main() {
  // A variable's name in its own initializer
  int n = sizeof(n);
  void* p = &p;
  Node loop = {&loop, 7};
  std::cout << n << g << (p == &p) << (gq == &gq) << self.next->next->v << loop.next->v << '\n';

  // Direct-initialization that reads like a function declaration
  f(4);
  f(5);
  std::cout << global.v << gi << '\n';

  // Functional casts
  int x = -5;
  std::cout << short(70000) << ' ' << unsigned(-1) << ' ' << unsigned(x) << ' ' << short(x * 20000) << '\n';
  std::cout << sizeof(short(1)) << sizeof(unsigned(1)) << sizeof(long(1)) << '\n';

  // Compound assignment evaluates its right operand first
  int z = 1;
  z += z++;
  int y = 2;
  y *= ++y;
  std::cout << z << y << '\n';
  a[idx()] += val();
  std::cout << a[1] << '\n';

  // Conditional operands of the same type
  bool t = true;
  char c = 'b';
  short s = 3;
  std::cout << (t ? 'a' : c) << (t ? c : 'z') << (t ? 'a' : 1) << sizeof(t ? s : (short)4) << '\n';

  // NULL is an integer null pointer constant
  long l = NULL;
  int* q = NULL;
  std::cout << NULL << l << (q == NULL) << sizeof(NULL) << '\n';
}
