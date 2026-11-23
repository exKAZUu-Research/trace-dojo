#include <iostream>
#include <numeric>

int input[] = {2, 3};

int add(const int& sum, const int& item) {
  std::cout << (&item == &input[0] || &item == &input[1]);
  return sum + item;
}

const int& select(const int& left, const int&) { return left; }

int live;
struct Product {
  int n;
  Product(int value) : n(value) { ++live; }
  Product(const Product& other) : n(other.n) { ++live; }
  ~Product() { --live; }
};

Product multiply(int a, int b) { return Product(a * b); }
int addProduct(int sum, Product item) {
  std::cout << live;
  return sum + item.n;
}

int main() {
  int output[2] = {};
  int sum = std::accumulate(input, input + 2, 0, add);
  std::cout << ' ' << sum << '\n';
  std::partial_sum(input, input + 2, output, add);
  std::cout << ' ' << output[1] << '\n';
  sum = std::inner_product(input, input + 2, input, 0, add, select);
  std::cout << ' ' << sum << '\n';
  sum = std::inner_product(input, input + 2, input, 0, addProduct, multiply);
  std::cout << ' ' << sum << ' ' << live << '\n';
}
