#include <iostream>
using namespace std;
int square(int x) { return x * x; }
double average(int a, int b) { return (a + b) / 2.0; }
void show(int n = 3) { cout << "n=" << n << endl; }
int fact(int n) { return n <= 1 ? 1 : n * fact(n - 1); }
int main() {
  int a = 7, b = 2;
  cout << a / b << " " << a % b << " " << -a / b << " " << -a % b << endl;
  cout << a / (double)b << " " << static_cast<double>(a) / b << endl;
  cout << square(5) << " " << average(3, 4) << " " << fact(10) << endl;
  show(); show(8);
  unsigned int u = 0; u--; cout << u << endl;
  long long big = 1LL << 40; cout << big << " " << sizeof(big) << " " << sizeof(int) << " " << sizeof(char) << endl;
  char c = 'A'; c += 2; cout << c << " " << (int)c << " " << c + 1 << endl;
  bool f = 3 > 2; cout << f << " " << !f << " " << (f && false) << endl;
  int x = 10; x += 5; x -= 3; x *= 2; x /= 4; x %= 4; cout << x << endl;
  int y = 5; int z = y++ + ++y; cout << y << " " << z << endl;
  cout << (5 & 3) << " " << (5 | 3) << " " << (5 ^ 3) << " " << (~5) << " " << (1 << 4) << " " << (-16 >> 2) << endl;
  int i = 0;
  while (i < 3) { cout << i; i++; }
  do { cout << i; i--; } while (i > 0);
  cout << endl;
  for (int j = 0; j < 10; j++) { if (j == 2) continue; if (j == 5) break; cout << j; }
  cout << endl;
  switch (a) { case 1: cout << "one"; break; case 7: cout << "seven"; case 8: cout << "eight"; break; default: cout << "other"; }
  cout << endl;
  int arr[5] = {1, 2, 3};
  for (int k = 0; k < 5; k++) cout << arr[k] << ",";
  cout << endl;
  int m[2][3] = {{1, 2, 3}, {4, 5, 6}};
  int sum = 0; for (auto& row : m) for (int v : row) sum += v;
  cout << sum << " " << sizeof(m) / sizeof(m[0]) << endl;
  double d = 3.14159;
  cout << d << " " << 1e10 << " " << 1e-5 << " " << 123456789.0 << " " << 0.1 + 0.2 << " " << 2.0 << endl;
  float fl = 1.0f / 3; cout << fl << " " << (double)fl << endl;
  cout << 7 / 2 * 2.0 << " " << 'a' << 'b' << " " << "str" << endl;
  int* p = &a; *p = 100; cout << a << " " << *p << endl;
  int& r = b; r = 50; cout << b << endl;
  const int N = 3; int arr2[N] = {}; cout << arr2[2] << endl;
  cout << (a > b ? "big" : "small") << endl;
  return 0;
}
