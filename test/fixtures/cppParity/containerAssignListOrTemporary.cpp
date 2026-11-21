#include <iostream>
#include <vector>
#include <deque>
std::vector<int> make(int n) { return std::vector<int>(n); }
struct A{ int v; A(int x):v(x){std::cout<<"C"<<v<<' ';} A(const A&o):v(o.v){std::cout<<"cp"<<v<<' ';} ~A(){std::cout<<"D"<<v<<' ';} };
int main(){
  std::vector<int> v(10); v = {1,2}; std::cout<<v.capacity()<<v.size()<<'\n';
  v = make(3); std::cout<<v.capacity()<<'\n';
  std::vector<int> g(28); g = std::vector<int>(2); std::cout<<g.capacity()<<'\n';
  std::vector<A> a; a.reserve(4); a.emplace_back(1); a.emplace_back(2);
  std::cout<<"\n1: "; a = {A(5)};
  std::cout<<"\n2: "; a = std::vector<A>(1, A(6));
  std::deque<A> d; d.emplace_back(1);
  std::cout<<"\n3: "; d = {A(7), A(8)};
  std::cout<<"\nend: ";
}
