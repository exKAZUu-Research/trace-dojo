#include <iostream>
#include <deque>
#include <list>
#include <stack>
#include <queue>
#include <array>
#include <vector>
#include <functional>
using namespace std;
int main() {
  deque<int> d = {2, 3}; d.push_front(1); d.push_back(4); d.pop_front();
  for (int x : d) cout << x; cout << " " << d.front() << d.back() << d[1] << endl;
  list<int> l = {3, 1, 2, 3}; l.push_front(0); l.remove(3); l.sort(); l.reverse();
  for (int x : l) cout << x; cout << " " << l.size() << endl;
  stack<string> st; st.push("a"); st.push("b"); cout << st.top() << st.size(); st.pop(); cout << st.top() << endl;
  queue<int> q; for (int i = 0; i < 4; i++) q.push(i); q.pop(); cout << q.front() << q.back() << q.size() << endl;
  priority_queue<int, vector<int>, greater<int>> pq; for (int x : {5, 1, 4, 2, 3}) pq.push(x);
  while (!pq.empty()) { cout << pq.top(); pq.pop(); } cout << endl;
  priority_queue<pair<int, char>> pp; pp.push({2, 'a'}); pp.push({5, 'b'}); pp.push({2, 'c'}); pp.emplace(5, 'a');
  while (!pp.empty()) { cout << pp.top().first << pp.top().second << " "; pp.pop(); } cout << endl;
  array<int, 4> arr = {4, 3, 2}; arr.fill(7); arr[0] = 1; for (int x : arr) cout << x; cout << arr.size() << endl;
  vector<pair<string, int>> vp = {{"x", 1}}; vp.emplace_back("y", 2); for (auto& p : vp) cout << p.first << p.second; cout << endl;
}
