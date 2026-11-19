#include <iostream>
#include <string>
#include <vector>
using namespace std;

const string constText() {
  string text(30, 'a');
  text.reserve(100);
  return text;
}

string movableText() {
  string text(30, 'a');
  text.reserve(100);
  return text;
}

int main() {
  string s = "abcdef", t = "XYZ";
  s.insert(2, t, 1, 1); cout << s << '\n';
  s.insert(0, t, 1); cout << s << '\n';
  s.insert(1, "pqrs", 2); cout << s << '\n';
  s.replace(0, 1, t, 0, 2); cout << s << '\n';
  s.replace(0, 2, "hello", 3); cout << s << '\n';
  s.append(t.begin(), t.end()); cout << s << '\n';
  string copy = s;
  cout << (&copy == &copy.append(t.begin(), t.end())) << (&copy == &copy.erase()) << '\n';
  s.append(t.rbegin(), t.rend()); cout << s << '\n';
  s.append("pq", 1); cout << s << '\n';
  s.assign(s, 1, 4); cout << s << '\n';
  s.assign("abcdef", 3); cout << s << '\n';
  s.assign(t.begin() + 1, t.end()); cout << s << '\n';
  s = "abcdef";
  cout << s.compare(0, 2, "abX", 2) << ' ' << s.compare(1, 3, t, 0, 2) << ' ' << s.compare(1, 3, string("bcd")) << '\n';
  cout << s.compare(2, 2, "cdef", 1, 2) << '\n';
  s.replace(s.begin(), s.begin() + 2, "W"); cout << s << '\n';
  s.replace(s.begin(), s.begin() + 1, t); cout << s << '\n';
  s.replace(s.begin(), s.begin() + 1, "mnop", 2); cout << s << '\n';
  s.replace(s.begin(), s.begin() + 1, 3, 'z'); cout << s << '\n';
  s.replace(s.begin(), s.begin() + 3, t.rbegin(), t.rend()); cout << s << '\n';
  auto it = s.insert(s.begin() + 1, 2, 'k'); cout << s << ' ' << *it << '\n';
  auto it2 = s.insert(s.begin(), t.begin(), t.end()); cout << s << ' ' << *it2 << '\n';
  string r(s.rbegin(), s.rend()); cout << r << '\n';
  vector<char> v = {'h', 'i'};
  string w(v.begin(), v.end()); cout << w << '\n';
  char a[] = "array";
  string x(a, a + 3); cout << x << '\n';
  const char* p = "pointer";
  string y(p, p + 4); cout << y << '\n';
  y.append(p + 4, p + 7); cout << y << '\n';
  string u{66}; cout << u << '\n';
  string q{5, 'a'}; cout << q.size() << q[1] << '\n';
  string z; z = 65.5; cout << z << '\n';
  z += 66; z += {'c', 'd'}; cout << z << '\n';
  z = {'x', 'y'}; cout << z << '\n';
  string m = "a", n = "b"; swap(m, n); cout << m << n << '\n'; std::swap(m, n); cout << m << n << '\n'; m.swap(n); cout << m << n << '\n';
  cout << string("a").compare("B") << ' ' << string("a").compare("\xff") << ' ' << string("abc").compare("abd") << ' ' << string("abc").compare("a") << '\n';
  cout << (s + 'c') << ' ' << ('c' + s) << '\n';
  auto left = constText() + "b";
  auto right = "b" + constText();
  auto moved = movableText() + "b";
  string empty, reserved(40, 'b');
  reserved.reserve(200);
  empty = constText();
  reserved = constText();
  cout << left.capacity() << ' ' << right.capacity() << ' ' << moved.capacity() << ' '
       << empty.capacity() << ' ' << reserved.capacity() << '\n';
  try { s.insert(100, t, 0, 1); } catch (const out_of_range& e) { cout << e.what() << '\n'; }
  try { s.insert(0, t, 100, 1); } catch (const out_of_range& e) { cout << e.what() << '\n'; }
  try { s.compare(0, 1, t, 100, 1); } catch (const out_of_range& e) { cout << e.what() << '\n'; }
  try { s.compare(100, 1, t, 0, 1); } catch (const out_of_range& e) { cout << e.what() << '\n'; }
}
