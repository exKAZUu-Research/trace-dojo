#include <algorithm>
#include <iostream>
#include <iterator>
#include <vector>

struct Value {
  int n;
  Value() : n(0) {}
  Value(int value) : n(value) { std::cout << 'C'; }
  ~Value() { std::cout << 'D'; }
};

int number(int n) { return n; }
Value object(int n) { return Value(n); }

int main() {
  int input[] = {1, 2};
  {
    Value output[2];
    std::transform(input, input + 2, output, number);
    std::cout << output[0].n << output[1].n;
    std::transform(input, input + 2, output, object);
    std::cout << output[0].n << output[1].n;
  }
  {
    std::vector<Value> output;
    output.reserve(2);
    std::transform(input, input + 2, std::back_inserter(output), number);
    std::cout << output[0].n << output[1].n;
  }
}
