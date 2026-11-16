#include <iostream>
#include <vector>
#include <set>
#include <list>
#include <string>
#include <deque>
#include <map>
#include <utility>
int main(){
  std::set<int> s{3,1,2}; std::vector<int> v(s.begin(), s.end()); std::cout<<v.size()<<v[0]<<'\n';
  std::list<int> l{4,5,6}; std::vector<int> v2(l.begin(), l.end()); std::cout<<v2[2]<<'\n';
  std::string str="hey"; std::vector<char> vc(str.begin(), str.end()); std::cout<<vc[1]<<'\n';
  std::vector<int> vi(str.begin(), str.end()); std::cout<<vi[0]<<'\n';
  int a[]={7,8,9}; std::vector<int> va(a, a+3); std::cout<<va[2]<<'\n';
  std::vector<long long> vl(a, a+2); std::cout<<vl[1]<<'\n';
  std::list<int> l2(v.begin(), v.end()); std::cout<<l2.back()<<'\n';
  std::deque<int> d(s.rbegin(), s.rend()); std::cout<<d.front()<<'\n';
  std::map<int,int> m{{1,2},{3,4}}; std::vector<std::pair<int,int>> vp(m.begin(), m.end()); std::cout<<vp[1].second<<'\n';
  v.assign(l.begin(), l.end()); std::cout<<v.size()<<v[0]<<'\n';
  v.assign(a, a+2); std::cout<<v.size()<<v[0]<<'\n';
  v.insert(v.end(), s.begin(), s.end()); std::cout<<v.size()<<v[4]<<'\n';
  v.insert(v.begin()+1, a, a+3); for(int x:v) std::cout<<x<<' '; std::cout<<'\n';
  v.assign(v2.begin(), v2.end()); std::cout<<v.size()<<'\n';
  std::vector<int> v3(std::begin(a), std::end(a)); std::cout<<v3.size()<<'\n';
  std::list<int> l3; l3.assign(s.begin(), s.end()); l3.insert(l3.begin(), a, a+1); for(int x:l3) std::cout<<x; std::cout<<'\n';
  std::vector<int> v4(v.begin(), v.end()); std::cout<<v4.size()<<'\n';
  std::vector<int> v5(v.cbegin(), v.cend()); std::cout<<v5.size()<<'\n';
  std::vector<int> v6(v.rbegin(), v.rend()); std::cout<<v6[0]<<'\n';
}
