#include <iostream>
#include <vector>
#include <string>
using namespace std;
int main() {
  vector<int> v;
  for (int i = 0; i < 10; i++) { v.push_back(i * i); cout << v.capacity() << " "; }
  cout << endl << v.size() << " " << v.front() << " " << v.back() << endl;
  v.pop_back(); v.erase(v.begin() + 1); v.insert(v.begin(), 100);
  for (size_t i = 0; i < v.size(); i++) cout << v[i] << " ";
  cout << endl;
  vector<string> names = {"bob", "alice"};
  names.emplace_back("carol");
  for (const auto& n : names) cout << n << " ";
  cout << names.size() << endl;
  vector<vector<int>> grid(3, vector<int>(4, 0));
  grid[1][2] = 5;
  for (auto& row : grid) { for (int x : row) cout << x; cout << endl; }
  vector<int> a = {1, 2, 3}, b = {1, 2, 4};
  cout << (a == b) << (a < b) << endl;
  a.resize(5); for (int x : a) cout << x; cout << endl;
  a.clear(); cout << a.empty() << a.size() << endl;
  vector<int> c(v.begin(), v.begin() + 3); for (int x : c) cout << x << ","; cout << endl;
  for (auto it = c.rbegin(); it != c.rend(); ++it) cout << *it << ";";
  cout << endl;
  vector<double> d(3, 1.5); d.assign(2, 2.5); for (double x : d) cout << x << " "; cout << endl;
  int sum = 0; for (auto it = v.begin(); it != v.end(); it++) sum += *it; cout << sum << endl;
  vector<int> e = v; e[0] = -1; cout << v[0] << " " << e[0] << endl;
}
