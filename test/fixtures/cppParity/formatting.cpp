#include <iostream>
#include <iomanip>
#include <cstdio>
#include <string>
using namespace std;
int main() {
  double vals[] = {0, 1, -1.5, 3.14159265358979, 1e-7, 1234567.891, 1e21, 0.000123456, 100, 2.5e-300};
  for (double v : vals) cout << v << " | " << fixed << setprecision(2) << v << " | " << scientific << setprecision(3) << v << " | " << defaultfloat << setprecision(4) << v << setprecision(6) << endl;
  cout << setw(8) << 42 << "|" << left << setw(8) << 42 << "|" << right << setfill('0') << setw(6) << -42 << setfill(' ') << endl;
  cout << internal << setw(8) << -42 << "|" << showpos << 42 << " " << 3.5 << noshowpos << endl;
  cout << hex << 255 << " " << showbase << 255 << " " << uppercase << 255 << nouppercase << noshowbase << dec << " " << oct << 8 << dec << endl;
  cout << boolalpha << true << " " << false << noboolalpha << " " << true << endl;
  cout << showpoint << 2.0 << " " << 1.5 << noshowpoint << " " << 2.0 << endl;
  cout << setprecision(0) << 2.5 << " " << fixed << 2.5 << " " << 3.5 << defaultfloat << setprecision(6) << endl;
  cout << setw(5) << "ab" << "|" << setw(3) << 'c' << "|" << endl;
  cout << hex << -1 << dec << " " << (unsigned char)65 << " " << (signed char)66 << endl;
  printf("%d %5d %-5d| %05d %+d %x %X %o %#x %u\n", 42, 42, 42, 42, 42, 255, 255, 8, 255, 3000000000u);
  printf("%f %.2f %10.3f %-10.1f| %e %.3E %g %g %g\n", 3.14159, 3.14159, 2.5, 2.5, 12345.678, 0.00012, 0.0001, 1e-5, 123456789.0);
  printf("%s %10s %-10s| %.2s %c %% %ld %lld %lu\n", "hi", "right", "left", "abcdef", 'Z', 123456789012L, -9LL, 18446744073709551615UL);
  string s = "world"; printf("hello %s %zu\n", s.c_str(), s.size());
  printf("[%*.*d] %hhu %hu %.1Lf\n", -5, 3, 7, (unsigned char)255, (unsigned short)65535, 1.5L);
  char buf[32]; sprintf(buf, "%03d-%s", 7, "x"); puts(buf);
  putchar('!'); putchar('\n');
  cout << 1.0 / 0 << " " << -1.0 / 0 << " " << 0.0 / 0 << endl;
  cout << setprecision(10) << 1.0 / 3 << " " << setprecision(17) << 0.1 << endl;
  cout.precision(3); cout << 3.14159 << " " << cout.precision() << endl;
  cout << 1e100 << " " << 123.0f << " " << 0.1f << endl;
}
