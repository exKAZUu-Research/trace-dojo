#include <iostream>
#include <utility>
template <unsigned long... I, class... Args>
void f(std::index_sequence<I...>, Args&&... args) { std::cout << sizeof...(I) << sizeof...(Args) << "\n"; }
template <class S, unsigned long... I, class... Args>
void g(S& s, std::index_sequence<I...>, Args&&... args) { std::cout << s << sizeof...(I) << sizeof...(Args) << "\n"; }
int main() { f(std::make_index_sequence<3>{}, 1, 2); int s = 7; g(s, std::index_sequence<0, 1>{}, 5); f(std::index_sequence<>{}); }
