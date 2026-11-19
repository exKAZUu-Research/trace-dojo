#include <cmath>
#include <cstdio>
#include <iomanip>
#include <iostream>
#include <random>
double A = 0.1, B = 10.0, C = 1.0, D = 0.3, E = 3.0;
const double K = 0.1 * 10.0 - 1.0;
const double fixedSource = 0.1, fixedCopy = fixedSource, fixedTen = 10.0;
const double& fixedAlias = fixedSource;
double printed(char name, double value) { std::cout << name; return value; }
double& destination(double& value) { std::cout << 't'; return value; }
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
  printf("%a %a %a\n", double{a * b} - c, float{fa * fb} - fc, double{fa * fb} - c);
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
  double f = -1.0;
  destination(f) += printed('l', a) * printed('r', b);
  printf(" %a\n", f);
  int calls = 0;
  printf("%a\n", (++calls, a * b) - c);
  printf("%a\n", double{(++calls, a * b)} - c);
  double negated = c + -(++calls, a * b);
  printf("%a %d\n", negated, calls);
  int values[]{9, 0}, index = 0;
  values[index++] += index;
  std::cout << values[0] << ' ' << index << '\n';
  const double localSource = 0.1, localCopy = localSource;
  static const double storedCopy = fixedSource;
  const double& localAlias = localSource;
  const double& aliasToStatic = fixedAlias;
  printf("%a %a %a %a %a %a\n", fixedCopy * fixedTen - c, fixedAlias * fixedTen - c,
         localCopy * fixedTen - c, storedCopy * fixedTen - c,
         aliasToStatic * fixedTen - c, localAlias * fixedTen - c);
}
