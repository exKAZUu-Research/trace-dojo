#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <list>
#include <stdexcept>
#include <string>
#include <vector>
using namespace std;
int main() {
  string s;
  cout << s.capacity() << " " << s.max_size() << endl;
  for (int i = 0; i < 100; i++) {
    s += 'a';
    if (i % 10 == 0) cout << s.capacity() << " ";
  }
  cout << endl;
  string t(23, 'x');
  cout << t.capacity() << " ";
  t.reserve(100);
  cout << t.capacity() << " ";
  t.shrink_to_fit();
  cout << t.capacity() << " ";
  t = string(60, 'y');
  cout << t.capacity() << " ";
  t = "short";
  cout << t.capacity() << " ";
  string u(30, 'u');
  u = s;
  cout << u.capacity() << " " << (u + u).capacity() << " " << (string(30, 'a') + "b").capacity() << endl;
  string w(40, 'w'), e;
  w.swap(e);
  w.insert(0, 30, 'x');
  cout << w.capacity() << " " << e.capacity() << endl;
  cout << vector<int>().max_size() << " " << vector<double>().max_size() << " " << vector<char>().max_size() << " "
       << list<int>().max_size() << endl;
  vector<int> v(3);
  try { v.resize(SIZE_MAX); } catch (const length_error& error) { cout << "resize " << error.what() << endl; }
  try { v.reserve(-1); } catch (const length_error& error) { cout << "reserve " << error.what() << endl; }
  try { vector<int> big(-1); } catch (const length_error& error) { cout << "vector(n) " << error.what() << endl; }
  try { v.insert(v.end(), v.max_size(), 1); } catch (const length_error& error) { cout << "insert " << error.what() << endl; }
  try { s.resize(SIZE_MAX); } catch (const length_error& error) { cout << "resize " << error.what() << endl; }
  try { s.append(s.max_size() - 1, 'a'); } catch (const length_error& error) { cout << "append " << error.what() << endl; }
  try { string big(-1, 'a'); } catch (const length_error& error) { cout << "string(n, c) " << error.what() << endl; }
  cout << v.size() << " " << s.size() << endl;
  cout << numeric_limits<int>::epsilon() << numeric_limits<int>::infinity() << numeric_limits<long long>::quiet_NaN()
       << endl;
  cout << isnan(1) << isinf(2) << isfinite(3) << signbit(-4) << endl;
  intmax_t a = -5;
  uintmax_t b = 6;
  std::int8_t c = 7;
  cout << a << b << c + 0 << sizeof(a) << sizeof(b) << endl;
}
