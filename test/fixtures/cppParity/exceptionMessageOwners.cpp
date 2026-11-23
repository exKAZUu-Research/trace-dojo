#include <iostream>
#include <stdexcept>
#include <vector>

struct Row : std::runtime_error {
  std::vector<int> values;
  Row() : std::runtime_error("moved") {}
};

int main() {
  const char* saved;
  std::runtime_error* copied;
  {
    std::runtime_error source("copied");
    saved = source.what();
    copied = new std::runtime_error(source);
  }
  std::cout << saved << ' ' << (copied->what() == saved) << '\n';
  delete copied;

  std::logic_error assigned("old");
  {
    std::logic_error source("assigned");
    assigned = source;
    saved = source.what();
  }
  std::cout << saved << ' ' << (assigned.what() == saved) << '\n';

  std::vector<Row> rows(1);
  rows[0].values.push_back(8);
  saved = rows[0].what();
  int* cell = rows[0].values.data();
  rows.reserve(8);
  std::cout << saved << ' ' << (rows[0].what() == saved) << ' ' << *cell << '\n';
}
