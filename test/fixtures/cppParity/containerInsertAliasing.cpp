#include <iostream>
#include <deque>
#include <vector>
void show(const std::deque<int>& d){ for(int x:d) std::cout<<x<<' '; std::cout<<'\n'; }
void showv(const std::vector<int>& d){ for(int x:d) std::cout<<x<<' '; std::cout<<'\n'; }
int main(){
  std::deque<int> d; for(int i=0;i<10;i++) d.push_back(i);
  d.insert(d.end()-2, 3, d[8]); show(d);
  d.insert(d.end()-2, 1, d[d.size()-1]); show(d);
  d.insert(d.end()-1, 5, d[d.size()-3]); show(d);
  d.insert(d.begin()+2, 5, d[1]); show(d);
  d.insert(d.begin()+3, 2, d[0]); show(d);
  d.insert(d.begin()+3, 1, d[2]); show(d);
  d.insert(d.begin()+1, d[0]); show(d);
  d.insert(d.end()-1, d[d.size()-1]); show(d);
  std::vector<int> v; v.reserve(40); for(int i=0;i<10;i++) v.push_back(i);
  v.insert(v.begin()+2, 3, v[5]); showv(v);
  v.insert(v.begin()+2, 12, v[3]); showv(v);
  v.insert(v.begin()+1, v[4]); showv(v);
  v.insert(v.end()-1, 2, v[v.size()-1]); showv(v);
}
