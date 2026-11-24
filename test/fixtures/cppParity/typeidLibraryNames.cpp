#include <iostream>
#include <typeinfo>
#include <vector>
#include <list>
struct P {};
int main() { std::cout << typeid(std::vector<int>).name() << " " << typeid(std::vector<P>).name() << " " << typeid(std::list<double>).name() << " " << typeid(std::vector<std::vector<int>>).name() << "\n"; }
