#include <iostream>
#include <map>
#include <set>
#include <unordered_map>
#include <unordered_set>
#include <utility>
struct A{ int v; A(int x):v(x){std::cout<<"C"<<v<<' ';} A(const A&o):v(o.v){std::cout<<"cp"<<v<<' ';} ~A(){std::cout<<"D"<<v<<' ';} };
int main(){
  std::map<int,A> m;
  std::cout<<"\n1: "; m.insert(std::make_pair(3, A(8)));
  std::cout<<"\n2: "; m.emplace(3, 9);
  std::cout<<"\n3: "; m.insert({3, A(5)});
  std::cout<<"\n4: "; m.emplace(4, 6);
  std::cout<<"\n5: "; std::pair<const int, A> p(7, A(1)); m.insert(p);
  std::cout<<"\n6: "; m.insert(p);
  std::cout<<"\n7: "; m.emplace(p);
  std::cout<<"\n8: "; m.try_emplace(4, 2); m.try_emplace(9, 2);
  std::cout<<"\n9: "; m.insert(m.begin(), {10, A(3)});
  std::cout<<"\n10: "; m.emplace(std::make_pair(11, A(4)));
  std::cout<<"\n11: "; m.emplace(std::make_pair(11, A(4)));
  std::cout<<"\nend: ";
}
