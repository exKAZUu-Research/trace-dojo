#include <iostream>
template <class... Ts> auto first(Ts... xs) { Ts...[0] y = xs...[0]; return y; }
template <class... Ts> auto last(Ts... xs) { return xs...[sizeof...(xs) - 1]; }
int main() { std::cout << first(3, 'a') << last(1, 2.5) << "\n"; }
