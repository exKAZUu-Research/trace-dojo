#include <iostream>
#include <map>
#include <set>
#include <unordered_map>
#include <unordered_set>
#include <string>
#include <vector>
using namespace std;
int main() {
  map<string, int> score = {{"bob", 70}, {"alice", 90}};
  score["carol"] = 85; score["bob"] += 5;
  for (auto& p : score) cout << p.first << ":" << p.second << " ";
  cout << score.size() << " " << score.count("alice") << score.count("dave") << endl;
  auto it = score.find("bob"); if (it != score.end()) cout << it->second << endl;
  score.erase("alice");
  for (auto it2 = score.begin(); it2 != score.end(); ++it2) cout << it2->first << " ";
  cout << endl;
  map<int, vector<int>> mv; mv[3].push_back(1); mv[1].push_back(2); mv[3].push_back(4);
  for (auto& p : mv) { cout << p.first << ":"; for (int x : p.second) cout << x; cout << " "; }
  cout << endl;
  set<int> s = {5, 3, 9, 1}; s.insert(4); s.insert(3); s.erase(9);
  for (int x : s) cout << x; cout << " " << *s.begin() << *s.rbegin() << " " << *s.lower_bound(4) << *s.upper_bound(4) << endl;
  auto r = s.insert(7); cout << r.second << *r.first << s.insert(7).second << endl;
  multiset<int> ms = {3, 1, 3, 2}; for (int x : ms) cout << x; cout << ms.count(3) << endl;
  map<char, int> freq; string text = "mississippi"; for (char c : text) freq[c]++;
  for (auto& kv : freq) cout << kv.first << kv.second; cout << endl;
  unordered_map<int, string> um; for (int i = 0; i < 20; i++) um[i * 37 % 23] = to_string(i);
  for (auto& p : um) cout << p.first << "=" << p.second << " ";
  cout << endl << um.bucket_count() << endl;
  unordered_set<string> words = {"the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog"};
  for (auto& w : words) cout << w << " ";
  cout << endl;
  unordered_map<string, int> cnt; for (string w : {"a", "b", "a", "c", "b", "a"}) cnt[w]++;
  for (auto& p : cnt) cout << p.first << p.second << " ";
  cout << endl;
  map<int, int, greater<int>> desc = {{1, 1}, {3, 3}, {2, 2}}; for (auto& p : desc) cout << p.first; cout << endl;
  pair<int, string> pr = make_pair(1, "one"); cout << pr.first << pr.second << endl;
  try { score.at("zzz"); } catch (out_of_range& e) { cout << e.what() << endl; }
}
