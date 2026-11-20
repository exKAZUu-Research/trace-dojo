#include <exception>
#include <functional>
#include <iostream>
#include <limits>
#include <random>
#include <stdexcept>
#include <vector>

struct Row {
  std::exception error;
  std::less<int> less;
  std::numeric_limits<int> limits;
  std::mt19937 engine;
  std::uniform_int_distribution<int> distribution;
  std::vector<int> values;
};

struct WithBase : std::runtime_error {
  std::vector<int> values;
  WithBase() : std::runtime_error("base message") {}
};

int main() {
  std::vector<Row> rows(1);
  rows[0].values.push_back(7);
  int* cell = rows[0].values.data();
  rows.reserve(8);
  std::cout << *cell << ' ' << rows[0].less(1, 2) << ' ' << rows[0].engine() << '\n';

  std::vector<WithBase> based(1);
  based[0].values.push_back(8);
  int* baseCell = based[0].values.data();
  based.reserve(8);
  std::cout << *baseCell << ' ' << based[0].what() << '\n';
}
