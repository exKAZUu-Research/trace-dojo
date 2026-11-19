#include <iostream>
#include <numeric>

int live;
struct Sum {
  int n;
  Sum(int value) : n(value) { ++live; }
  Sum(const Sum& other) : n(other.n) { ++live; }
  ~Sum() { --live; }
};

Sum add(const Sum& a, int b) { return Sum(a.n + b); }
Sum addSums(const Sum& a, const Sum& b) { return Sum(a.n + b.n); }
int multiply(int a, int b) { return a * b; }

int main() {
  int input[] = {1, 2};
  {
    Sum initial(0);
    {
      auto result = std::accumulate(input, input + 2, initial, add);
      std::cout << live << ' ' << result.n << ' ';
    }
    auto result = std::inner_product(input, input + 2, input, initial, add, multiply);
    std::cout << live << ' ' << result.n << ' ';
  }
  std::cout << live << ' ';
  {
    Sum input[] = {1, 2};
    Sum output[] = {0, 0};
    std::partial_sum(input, input + 2, output, addSums);
    std::cout << live << ' ' << output[1].n << ' ';
  }
  std::cout << live;
}
