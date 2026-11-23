#include <iostream>
#include <numeric>
#include <vector>

struct Token {
  int n;
  Token(int value) : n(value) {}
  Token(const Token& other) : n(other.n) { std::cout << 'C'; }
  ~Token() { std::cout << 'D'; }
};

struct Sum { std::vector<Token> values; };
Sum replace(const Sum&, int n) { return Sum{{Token(n)}}; }
Sum byValue(Sum sum, int n) {
  std::cout << sum.values[0].n;
  return Sum{{Token(n)}};
}
int multiply(int a, int b) { return a * b; }

struct Guard {
  Guard() {}
  Guard(const Guard&) { std::cout << 'G'; throw 1; }
};

struct CheckedSum { std::vector<Token> values; Guard guard; };
CheckedSum replaceChecked(const CheckedSum&, int n) { return CheckedSum{{Token(n)}, Guard{}}; }

int main() {
  int input[] = {3};
  {
    auto result = std::accumulate(input, input + 1, Sum{}, replace);
    std::cout << '|' << result.values[0].n << '|';
  }
  std::cout << '\n';
  {
    auto result = std::inner_product(input, input + 1, input, Sum{}, replace, multiply);
    std::cout << '|' << result.values[0].n << '|';
  }
  std::cout << '\n';
  {
    auto result = std::accumulate(input, input + 1, Sum{{Token(1)}}, byValue);
    std::cout << '|' << result.values[0].n << '|';
  }
  std::cout << '\n';
  try {
    std::accumulate(input, input + 1, CheckedSum{}, replaceChecked);
  } catch (int) {
    std::cout << " caught\n";
  }
}
