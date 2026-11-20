#include <algorithm>
#include <iostream>
#include <iterator>
#include <list>
#include <map>
#include <set>
#include <vector>
using namespace std;
struct Point {
  int x;
};
int main() {
  vector<int> v = {1, 2, 3};
  map<int, int> m = {{1, 2}, {3, 4}};
  cout << *++v.begin() << " " << (--m.end())->first << " " << *--v.end() << " " << *(v.begin() += 2) << endl;
  list<int> l = {3, 1, 2};
  reverse(l.begin(), l.end());
  next_permutation(l.begin(), l.end());
  auto it = l.end();
  it--;
  cout << *it << *prev(l.end()) << *next(l.begin()) << distance(l.begin(), l.end()) << (l.begin() != l.end()) << endl;
  for (int x : l) cout << x;
  cout << endl;
  set<Point> points;
  map<Point, int> table;
  set<Point> copy = points;
  copy.clear();
  cout << points.size() << points.empty() << table.size() << (points.begin() == points.end()) << endl;
}
