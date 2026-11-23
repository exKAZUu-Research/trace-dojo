#include <iomanip>
#include <iostream>
using namespace std;
int main() {
  cout << setfill('*') << internal;
  cout << '[' << showpos << setw(12) << hexfloat << 1.5 << ']' << '[' << setw(12) << -1.5 << ']' << noshowpos;
  cout << '[' << setw(12) << 1.5 << ']' << defaultfloat << '\n';
  cout << '[' << showbase << oct << setw(8) << 8 << ']' << '[' << hex << setw(8) << 255 << ']';
  cout << '[' << dec << setw(8) << -5 << ']' << '[' << setw(8) << 0 << ']' << noshowbase << '\n';
  cout << '[' << setw(20) << (void*)0 << ']' << (void*)0 << '\n';
  cout << setfill(' ') << right;

  short s = -1;
  unsigned short us = 65534;
  cout << hex << s << ' ' << us << ' ' << showbase << s << ' ' << uppercase << s << noshowbase << nouppercase;
  cout << ' ' << oct << s << ' ' << dec << s << '\n';

  cout << boolalpha << '[' << setw(7) << true << "]\n";
  cout << '[' << left << setw(7) << false << "]\n";
  cout << "[x]\n";
  cout << noboolalpha << right << '[' << setw(4) << true << "]\n";

  cout.precision(-1);
  cout << 3.14159 << ' ' << fixed << 3.14159 << ' ' << scientific << 3.14159 << ' ' << uppercase << 1.5e10;
  cout << nouppercase << defaultfloat << ' ' << showpoint << 2.0 << noshowpoint << '\n';
  cout << setprecision(-3) << 1.0 / 3 << '\n';
}
