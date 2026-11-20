#include <iostream>
#include <vector>
#include <string>
#include <algorithm>
struct S { std::string name; int n; };
bool isA(const std::string& s){ return s == "a"; }
bool small(const S& s){ return s.n < 2; }
int replacement = 0;
bool chooseReplacement(int) { ++replacement; return true; }
int main(){
  std::vector<std::string> v{"a","b","a","c","a","d"};
  auto e=std::remove(v.begin(),v.end(),std::string("a"));
  std::cout<<(e-v.begin())<<':'; for(auto& x:v) std::cout<<'['<<x<<']'; std::cout<<'\n';
  std::vector<std::string> w{"x","x","y","z","z","y"};
  auto f=std::unique(w.begin(),w.end());
  std::cout<<(f-w.begin())<<':'; for(auto& x:w) std::cout<<'['<<x<<']'; std::cout<<'\n';
  std::vector<std::string> u{"a","q","a","r"};
  u.erase(std::remove_if(u.begin(),u.end(),isA), u.end());
  for(auto& x:u) std::cout<<'['<<x<<']'; std::cout<<'\n';
  std::vector<std::string> t{"a","q","a","r","s"};
  std::remove_if(t.begin(),t.end(),isA); for(auto& x:t) std::cout<<'['<<x<<']'; std::cout<<'\n';
  std::vector<S> ss{{"p",1},{"q",5},{"r",0},{"s",7}};
  std::remove_if(ss.begin(),ss.end(),small); for(auto& x:ss) std::cout<<'['<<x.name<<x.n<<']'; std::cout<<'\n';
  std::vector<int> vi{1,2,1,3}; std::remove(vi.begin(), vi.end(), 1); for(int x:vi) std::cout<<x; std::cout<<'\n';
  v[3] = "changed"; for(auto& x:v) std::cout<<'['<<x<<']'; std::cout<<'\n';
  int replaced[] = {1, 2, 1};
  std::replace(replaced, replaced + 3, replaced[0], replaced[1]);
  for (int value : replaced) std::cout << value;
  std::cout << '\n';
  int removed[] = {1, 2, 3, 2};
  auto last = std::remove(removed, removed + 4, removed[1]);
  std::cout << (last - removed) << ':';
  for (auto current = removed; current != last; ++current) std::cout << *current;
  std::cout << '\n';
  int transformed[] = {3, 4};
  std::replace_if(transformed, transformed + 2, chooseReplacement, replacement);
  std::cout << transformed[0] << transformed[1] << '\n';
}
