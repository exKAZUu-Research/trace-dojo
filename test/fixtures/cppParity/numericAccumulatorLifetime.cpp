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

struct Choice {
  int value;
  Choice(int number = 0) : value(number) {}
  Choice(Choice& source) : value(source.value) { std::cout << 'M'; }
  Choice(const Choice& source) : value(source.value) { std::cout << 'C'; }
};

struct MutableOnly {
  int value;
  MutableOnly(int number = 0) : value(number) {}
  MutableOnly(MutableOnly& source) : value(source.value) { std::cout << 'L'; }
};

Choice combineChoices(const Choice& a, const Choice& b) { return Choice(a.value + b.value); }
MutableOnly combineMutable(const MutableOnly& a, const MutableOnly& b) { return MutableOnly(a.value + b.value); }

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
  std::cout << live << '\n';
  Choice choices[]{2, 3};
  const Choice constChoices[]{4, 5};
  Choice assigned[2];
  std::partial_sum(choices, choices, assigned, combineChoices);
  std::partial_sum(choices, choices + 2, assigned, combineChoices);
  std::cout << assigned[1].value << ' ';
  std::partial_sum(constChoices, constChoices + 2, assigned, combineChoices);
  std::cout << assigned[1].value << ' ';
  MutableOnly inputs[]{6, 7}, outputs[2];
  std::partial_sum(inputs, inputs + 2, outputs, combineMutable);
  std::cout << outputs[1].value << '\n';
}
