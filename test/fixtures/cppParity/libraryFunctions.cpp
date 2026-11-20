#include <iostream>
#include <vector>
#include <algorithm>
#include <numeric>
#include <iterator>
#include <random>
#include <string>
#include <cctype>
#include <utility>
#include <functional>
#include <map>
using namespace std;
bool isOdd(int x) { return x % 2 != 0; }
bool desc(int a, int b) { return a > b; }
void printIt(int x) { cout << x << ";"; }
int add(int a, int b) { return a + b; }
struct Item { string name; int price; };
bool cheaper(const Item& a, const Item& b) { return a.price < b.price; }
int main() {
  vector<int> v = {5, 3, 3, 9, 1, 3, 7};
  vector<int> s = v; stable_sort(s.begin(), s.end(), desc); for (int x : s) cout << x; cout << endl;
  sort(s.begin(), s.end()); s.erase(unique(s.begin(), s.end()), s.end()); for (int x : s) cout << x; cout << endl;
  vector<int> r = v; r.erase(remove_if(r.begin(), r.end(), isOdd), r.end()); cout << r.size() << endl;
  r = v; r.erase(remove(r.begin(), r.end(), 3), r.end()); for (int x : r) cout << x; cout << endl;
  vector<int> c; copy(v.begin(), v.end(), back_inserter(c)); cout << c.size() << endl;
  vector<int> f(4); fill(f.begin(), f.end(), 7); iota(c.begin(), c.end(), 10); for (int x : c) cout << x << ","; cout << endl;
  cout << all_of(v.begin(), v.end(), isOdd) << any_of(v.begin(), v.end(), isOdd) << none_of(v.begin(), v.end(), isOdd) << endl;
  for_each(v.begin(), v.end(), printIt); cout << endl;
  cout << accumulate(v.begin(), v.end(), 100, add) << " " << inner_product(v.begin(), v.end(), v.begin(), 0) << endl;
  vector<int> ps(v.size()); partial_sum(v.begin(), v.end(), ps.begin()); for (int x : ps) cout << x << " "; cout << endl;
  vector<int> rot = {1, 2, 3, 4, 5}; rotate(rot.begin(), rot.begin() + 2, rot.end()); for (int x : rot) cout << x; cout << endl;
  cout << clamp(15, 0, 10) << clamp(-3, 0, 10) << " " << equal(v.begin(), v.end(), v.begin()) << endl;
  int m1 = 4, m2 = 2; auto mm = minmax(m1, m2); cout << mm.first << mm.second << endl;
  vector<int> pr = {3, 2, 1}; prev_permutation(pr.begin(), pr.end()); for (int x : pr) cout << x; cout << endl;
  mt19937 g(7); vector<int> sh = {1, 2, 3, 4, 5, 6, 7, 8}; shuffle(sh.begin(), sh.end(), g); for (int x : sh) cout << x; cout << endl;
  mt19937_64 g64(123); cout << g64() << " " << uniform_int_distribution<long long>(-5, 5)(g64) << endl;
  vector<Item> items = {{"pen", 120}, {"book", 800}, {"eraser", 60}, {"note", 120}};
  sort(items.begin(), items.end(), cheaper); for (auto& it : items) cout << it.name << " "; cout << endl;
  auto most = max_element(items.begin(), items.end(), cheaper); cout << most->name << " " << distance(items.begin(), most) << endl;
  string t = "Hello World 123"; int up = 0, dig = 0; for (char ch : t) { if (isupper(ch)) up++; if (isdigit(ch)) dig++; }
  transform(t.begin(), t.end(), t.begin(), ::toupper); cout << t << " " << up << dig << endl;
  int x = 1, y = 2; swap(x, y); cout << x << y << endl;
  vector<int> big = {1, 2, 3}; vector<int> small = {9}; swap(big, small); cout << big.size() << small.size() << endl;
  auto it = find_if(v.begin(), v.end(), isOdd); cout << *it << " " << *next(it) << " " << *prev(v.end()) << " " << count(v.begin(), v.end(), 3) << endl;
  auto lb = lower_bound(s.begin(), s.end(), 4); cout << (lb - s.begin()) << " " << *upper_bound(s.begin(), s.end(), 5) << endl;
  cout << greater<int>()(3, 2) << plus<int>()(2, 3) << endl;
  map<string, int> ages; ages.insert({"amy", 30}); ages.emplace("ben", 25); auto res = ages.insert({"amy", 40}); cout << res.second << ages["amy"] << endl;
  cout << max({3, 8, 1}) << min({'b', 'a'}) << endl;
}
