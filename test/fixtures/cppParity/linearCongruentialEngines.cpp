#include <algorithm>
#include <iostream>
#include <iterator>
#include <random>
#include <vector>
int main() {
  std::default_random_engine e;
  std::cout << e() << " " << e() << " " << e.min() << " " << e.max() << "\n";
  std::minstd_rand0 z(42);
  std::cout << z() << "\n";
  std::default_random_engine g(2024);
  std::uniform_int_distribution<int> dice(1, 6);
  for (int i = 0; i < 10; ++i) std::cout << dice(g);
  std::cout << "\n";
  std::uniform_real_distribution<double> u(0.0, 1.0);
  std::cout << u(g) << " " << u(g) << "\n";
  std::uniform_real_distribution<float> uf(0.0f, 10.0f);
  std::cout << uf(g) << "\n";
  std::normal_distribution<double> n(0.0, 1.0);
  std::cout << n(g) << "\n";
  std::vector<int> v{1, 2, 3, 4, 5, 6, 7, 8};
  std::shuffle(v.begin(), v.end(), g);
  for (int x : v) std::cout << x;
  std::cout << "\n";
  std::vector<int> out;
  std::sample(v.begin(), v.end(), std::back_inserter(out), 3, g);
  for (int x : out) std::cout << x;
  std::cout << "\n";
  std::mt19937 mt(7);
  std::vector<char> letters{'a', 'b', 'c', 'd', 'e'};
  std::string picked;
  std::sample(letters.begin(), letters.end(), std::back_inserter(picked), 2, mt);
  std::cout << picked << "\n";
  std::uniform_int_distribution<long long> big(0, 1LL << 40);
  std::cout << big(g) << "\n";
}
