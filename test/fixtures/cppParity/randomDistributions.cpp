#include <cstdio>
#include <random>
#include <vector>
int main() {
  std::mt19937 gen(42);
  std::normal_distribution<double> nd(0, 1);
  std::bernoulli_distribution bd(0.5);
  std::discrete_distribution<int> dd{1, 2, 3};
  std::poisson_distribution<int> pd(3);
  std::exponential_distribution<double> ed(1.0);
  std::geometric_distribution<int> gd(0.3);
  std::binomial_distribution<int> bin(10, 0.5);
  for (int i = 0; i < 3; i++)
    printf("%f %d %d %d %f %d %d\n", nd(gen), (int)bd(gen), dd(gen), pd(gen), ed(gen), gd(gen), bin(gen));
  std::normal_distribution<> heights(170.0, 6.0);
  std::lognormal_distribution<double> ln(0, 0.5);
  std::cauchy_distribution<double> cd(0, 1);
  std::weibull_distribution<double> wd(2, 1);
  std::extreme_value_distribution<double> ev(0, 1);
  std::mt19937_64 big(7);
  printf("%.4f %.4f %.4f %.4f %.4f\n", heights(big), ln(big), cd(big), wd(big), ev(big));
  std::vector<double> w{0.1, 0.9};
  std::discrete_distribution<int> fromRange(w.begin(), w.end());
  int counts[2] = {};
  for (int i = 0; i < 100; i++) counts[fromRange(gen)]++;
  printf("%d %d\n", counts[0], counts[1]);
}
