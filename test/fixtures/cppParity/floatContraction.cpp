#include <cmath>
#include <cstdio>
#include <iomanip>
#include <iostream>
#include <random>
double A = 0.1, B = 10.0, C = 1.0, D = 0.3, E = 3.0;
const double K = 0.1 * 10.0 - 1.0;
double printed(char name, double value) { std::cout << name; return value; }
int main() {
  double a = A, b = B, c = C, d = D, e = E;
  printf("%a sep\n", a * b - c);
  printf("%a fma\n", std::fma(a, b, -c));
  printf("%a c-ab\n", c - a * b);
  printf("%a ab+cde\n", a * b + d * e);
  printf("fma1 %a fma2 %a\n", std::fma(a, b, d * e), std::fma(d, e, a * b));
  double x = a * b; printf("%a stored\n", x - c);
  double y = c; y -= a * b; printf("%a compound\n", y);
  printf("%a paren\n", (a * b) - c);
  printf("%a three\n", a * b * d - c);
  float fa = 0.1f, fb = 10.0f, fc = 1.0f; printf("%a float\n", (double)(fa * fb - fc));
  int i = 3; printf("%a mixed\n", a * i - 0.3);
  printf("%a neg\n", -(a * b) + c);
  printf("%a div\n", a / b + c);
  const double ca = 0.1;
  printf("%a %a %a\n", 0.1 * 10.0 - 1.0, K, ca * 10.0 - 1.0);
  std::mt19937 g(5);
  std::uniform_real_distribution<double> dd(-3.5, 12.25);
  std::uniform_real_distribution<float> df(1.5f, 9.75f);
  std::cout << std::setprecision(17);
  double sum = 0;
  for (int k = 0; k < 500; k++) { double u = dd(g); float v = df(g); sum += u + v; if (k % 100 == 0) std::cout << u << " " << v << "\n"; }
  std::cout << sum << "\n";
  std::cout << (printed('a', 1) + printed('b', 2) * printed('c', 3)) << '\n';
}
