#include <exception>
#include <iostream>
#include <stdexcept>

struct Marker {
  Marker() { std::cout << 'C'; }
  ~Marker() { std::cout << 'D'; }
};

struct CustomError : std::runtime_error {
  CustomError() : std::runtime_error("example") {}
  ~CustomError() override { std::cout << 'E'; }
};

int main() {
  (Marker{}, std::cout << 'X');
  static_cast<void>(Marker{});
  std::exception* error = new CustomError;
  const char* saved = error->what();
  std::cout << (saved == error->what()) << saved;
  delete error;
  std::cout << '\n';
}
