#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
using namespace std;
int main() {
  istringstream is("5");
  int x = 0;
  bool ok = static_cast<bool>(is >> x);
  cout << ok << (bool)is << bool(is) << !is << '\n';
  is >> x;
  cout << static_cast<bool>(is) << (bool)is << '\n';

  istringstream js("true ff 17 0x1F 010 abcdef");
  bool b = false;
  int h = 0, o = 0, p = 0, q = 0;
  js >> boolalpha >> b >> hex >> h >> oct >> o >> setbase(0) >> p >> q;
  cout << b << ' ' << h << ' ' << o << ' ' << p << ' ' << q << '\n';
  string w;
  js >> setw(3) >> w;
  cout << w << '\n';
  js >> w;
  cout << w << '\n';

  streamsize width = cout.width();
  streamsize precision = cout.precision();
  cout << width << ' ' << precision << '\n';
}
