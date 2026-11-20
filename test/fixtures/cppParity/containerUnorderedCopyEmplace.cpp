#include <iostream>
#include <unordered_map>
#include <unordered_set>
#include <string>
#include <utility>
#include <vector>
#include <set>
struct A{ int v; A(int x):v(x){std::cout<<"C"<<v<<' ';} A(const A&o):v(o.v){std::cout<<"cp"<<v<<' ';} ~A(){std::cout<<"D"<<v<<' ';} };
int main(){
  {
    std::unordered_map<int,A> m;
    std::cout<<"\n1: "; m.insert(std::make_pair(3, A(8)));
    std::cout<<"\n2: "; m.emplace(3, 9);
    std::cout<<"\n3: "; m.insert({3, A(5)});
    std::cout<<"\n4: "; m.emplace(4, 6);
    std::cout<<"\n5: "; std::pair<const int, A> p(7, A(1)); m.insert(p);
    std::cout<<"\n6: "; m.insert(p);
    std::cout<<"\n7: "; m.emplace(p);
    std::cout<<"\n8: "; m.try_emplace(4, 2); m.try_emplace(9, 2);
    std::cout<<"\n9: "; m.emplace(std::make_pair(11, A(4)));
    std::cout<<"\n10: "; m.emplace(std::make_pair(11, A(4)));
    std::cout<<"\nend: ";
  }
  std::cout<<'\n';
  std::unordered_map<int,int> mm; for(int i=0;i<100;i++) mm[i*i%97]=i;
  std::unordered_map<int,int> m2 = mm;
  for(auto&p:mm) std::cout<<p.first<<' '; std::cout<<'\n';
  for(auto&p:m2) std::cout<<p.first<<' '; std::cout<<'\n';
  std::unordered_map<int,int> m3; m3[5]=1; m3 = mm;
  for(auto&p:m3) std::cout<<p.first<<' '; std::cout<<'\n';
  std::unordered_set<std::string> s; for(int i=0;i<30;i++) s.insert(std::to_string(i*7));
  std::unordered_set<std::string> s2(s); std::unordered_set<std::string> s3; s3.insert("x"); s3 = s;
  for(auto&x:s) std::cout<<x<<' '; std::cout<<'\n';
  for(auto&x:s2) std::cout<<x<<' '; std::cout<<'\n';
  for(auto&x:s3) std::cout<<x<<' '; std::cout<<'\n';
  std::cout<<s.bucket_count()<<' '<<s2.bucket_count()<<' '<<s3.bucket_count()<<'\n';
  std::vector<int> v{5,3,9,3,1}; std::unordered_set<int> us(v.begin(), v.end()); for(int x:us) std::cout<<x<<' '; std::cout<<'\n';
  std::set<int> st(v.begin(), v.end()); int a[]={4,2}; st.insert(a, a+2); std::set<int> st2(a, a+2); for(int x:st) std::cout<<x; std::cout<<st2.size()<<'\n';
}
