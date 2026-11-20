#include <iomanip>
#include <iostream>
#include <iterator>
#include <limits>

struct Values {
  int data[2] = {4, 5};
  int* begin() { return data; }
  const int* begin() const { return data + 1; }
  const int* end() const { return data + 2; }
  short size() const { return 2; }
};

int main() {
  Values values;
  std::cout << *std::begin(values) << *std::cbegin(values)
            << std::end(values) - std::cbegin(values) << ' '
            << sizeof(std::size(values)) << std::size(values) << '\n';
  std::cout << std::setprecision(std::numeric_limits<double>::max_digits10) << 0.1 << '\n';
  std::cout << std::hexfloat << std::numeric_limits<float>::denorm_min() << ' '
            << std::numeric_limits<double>::denorm_min() << ' '
            << std::numeric_limits<unsigned>::denorm_min() << '\n';
  std::cout << std::numeric_limits<long double>::max_exponent10 << ' '
            << std::numeric_limits<unsigned>::is_modulo << std::numeric_limits<int>::is_modulo << '\n';
}
