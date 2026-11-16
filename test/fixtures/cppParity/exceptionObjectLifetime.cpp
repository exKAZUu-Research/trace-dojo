#include <iostream>
#include <stdexcept>

struct E {
  int id;
  E(int i) : id(i) { std::cout << "C" << id << " "; }
  E(const E& other) : id(other.id + 10) { std::cout << "cp" << id << " "; }
  ~E() { std::cout << "~E" << id << " "; }
};

struct Mine : std::runtime_error {
  Mine() : std::runtime_error("mine") {}
};

void fail() { throw E(1); }

int main() {
  try {
    fail();
  } catch (E e) {
    std::cout << "caught " << e.id << " ";
  }
  std::cout << "\n";
  try {
    throw E(2);
  } catch (const E& e) {
    std::cout << "caught " << e.id << " ";
  }
  std::cout << "\n";
  try {
    try {
      throw E(3);
    } catch (E& e) {
      std::cout << "inner ";
      throw;
    }
  } catch (E e) {
    std::cout << "outer " << e.id << " ";
  }
  std::cout << "\n";
  try {
    try {
      throw E(4);
    } catch (E e) {
      std::cout << "inner ";
      throw e;
    }
  } catch (E& e) {
    std::cout << "outer " << e.id << " ";
  }
  std::cout << "\n";
  try {
    E local(5);
    throw local;
  } catch (...) {
    std::cout << "any ";
  }
  std::cout << "\n";
  try {
    throw E(6);
  } catch (E& e) {
    try {
      throw;
    } catch (E copy) {
      std::cout << "nested ";
    }
    std::cout << "after ";
  }
  std::cout << "\n";
  for (int i = 0; i < 2; i++) {
    try {
      if (i == 1) throw E(7);
    } catch (const E& e) {
      std::cout << "continue ";
      continue;
    }
    std::cout << "loop ";
  }
  std::cout << "\n";

  try {
    throw std::runtime_error("boom");
  } catch (std::exception e) {
    std::cout << e.what() << "\n";
  }
  try {
    throw Mine();
  } catch (std::exception e) {
    std::cout << e.what() << "\n";
  }
  try {
    throw Mine();
  } catch (std::runtime_error e) {
    std::cout << e.what() << "\n";
  }
  try {
    throw Mine();
  } catch (const std::exception& e) {
    std::cout << e.what() << "\n";
  }
  try {
    throw std::out_of_range("range");
  } catch (std::logic_error e) {
    std::cout << e.what() << "\n";
  }
  std::exception sliced = std::runtime_error("r");
  std::cout << sliced.what() << "\n";
  std::logic_error assigned("a");
  assigned = std::out_of_range("b");
  std::cout << assigned.what() << "\n";
  sliced = std::runtime_error("c");
  std::cout << sliced.what() << "\n";
}
