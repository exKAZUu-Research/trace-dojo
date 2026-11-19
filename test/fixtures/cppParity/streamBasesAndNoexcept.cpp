#include <exception>
#include <iostream>
#include <new>
#include <sstream>
#include <stdexcept>

void read(std::istream& input) {
  int n;
  input >> n;
  std::cout << n;
}

void write(std::ostream& output) { output << "17"; }

struct Error : std::exception {
  const char* what() const noexcept override { return "error"; }
};

struct AllocationError : std::bad_alloc { int code; };
struct InvalidInput : std::invalid_argument { int code; };

struct Observed {
  Observed() {}
  Observed(const Observed&) { std::cout << 'C'; }
  ~Observed() { std::cout << 'D'; }
};

int handled() noexcept {
  try { throw 3; }
  catch (int n) { return n; }
}

int main() {
  std::stringstream stream("42");
  read(stream);
  std::stringstream other;
  write(other);
  std::istream* input = &other;
  read(*input);
  std::cout << handled();
  try { throw Error{}; }
  catch (const std::exception& value) { std::cout << value.what(); }
  try { throw Observed{}; }
  catch (Observed) { std::cout << 'X'; }
  std::cout << '\n' << sizeof(std::exception) << ' ' << sizeof(std::bad_exception) << ' '
            << sizeof(std::bad_alloc) << ' ' << sizeof(std::bad_array_new_length) << ' '
            << sizeof(std::runtime_error) << ' ' << sizeof(std::invalid_argument) << ' '
            << sizeof(AllocationError) << ' ' << sizeof(InvalidInput) << '\n';
}
