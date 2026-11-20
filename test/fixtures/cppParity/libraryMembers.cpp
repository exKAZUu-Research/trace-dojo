#include <iostream>
#include <iomanip>
#include <list>
#include <map>
#include <set>
#include <deque>
#include <vector>
#include <string>
#include <iterator>
#include <cstdio>
#include <cstring>
#include <cctype>
#include <limits>
using namespace std;
int main() {
  cout.put('A'); cout.write("bcdef", 3); cout << endl;
  cout.width(6); cout.fill('*'); cout << 42 << endl;
  cout.setf(ios::left, ios::adjustfield); cout.width(6); cout << 42 << "|" << endl;
  cout.unsetf(ios::left); cout.setf(ios_base::showpos); cout << 7 << endl; cout.unsetf(ios_base::showpos);
  cout << cout.flags() << " " << setiosflags(ios::uppercase) << hex << 255 << resetiosflags(ios::uppercase) << dec << endl;
  list<int> l = {1, 1, 2, 3, 3, 3}; l.unique(); for (int x : l) cout << x; cout << l.front() << l.back() << endl;
  multimap<string, int> mm; mm.insert({"a", 1}); mm.insert({"b", 2}); mm.insert({"a", 3});
  for (auto& p : mm) cout << p.first << p.second; cout << mm.count("a") << endl;
  set<int, greater<int>> sg = {1, 5, 3}; for (int x : sg) cout << x; cout << endl;
  deque<int> d(3, 9); d.emplace_front(1); d.insert(d.begin() + 1, 5); for (int x : d) cout << x; cout << d.at(1) << endl;
  vector<int> v = {4, 5, 6}; cout << size(v) << *begin(v) << *(end(v) - 1); auto it = v.begin(); advance(it, 2); cout << *it << endl;
  int arr[] = {7, 8}; cout << size(arr) << *begin(arr) << endl;
  cout << stol("123456789012") << " " << stoull("18446744073709551615") << " " << stof("1.5") << " " << stoi("ff", nullptr, 16) << " " << stoi("  42abc") << endl;
  size_t idx; stoi("12xy", &idx); cout << idx << endl;
  cout << numeric_limits<long long>::min() << " " << numeric_limits<char>::max() + 0 << " " << numeric_limits<float>::max() << endl;
  char buf[10]; snprintf(buf, sizeof(buf), "%d-%d-%d", 123, 456, 789); cout << buf << endl;
  fprintf(stdout, "%s\n", "to stdout"); fprintf(stderr, "err\n");
  cout << strncmp("abcd", "abce", 3) << " " << (strchr("hello", 'l') - "hello" >= 0) << " " << ispunct('!') << isspace(' ') << tolower('Q') << endl;
  string s = "a,b"; cout << s.find_last_of(',') << s.find_first_not_of("a") << s.compare(0, 1, "a") << endl;
  string t = "abc"; string u; u.assign(t); u.append(2, 'z'); u.insert(1, 2, '-'); u.replace(0, 1, 3, '#'); cout << u << endl;
  vector<int> w = {1, 2, 3, 4}; w.insert(w.end(), v.begin(), v.end()); w.erase(w.begin(), w.begin() + 2); for (int x : w) cout << x; cout << endl;
}
