#include <iostream>
#include <vector>

int failingDefault() {
  std::cout << "default" << std::endl;
  throw 6;
}

struct Token {
  Token() {}
  Token(const Token&, int = failingDefault()) noexcept {}
};

struct Row {
  std::vector<int> items;
  Token token;
};

int main() {
  std::vector<Token> tokens(1);
  try {
    tokens.reserve(8);
  } catch (int failure) {
    std::cout << "caught " << failure << std::endl;
  }

  std::vector<Row> rows(1);
  rows[0].items.push_back(7);
  try {
    rows.reserve(8);
  } catch (int failure) {
    std::cout << "caught " << failure << std::endl;
  }
}
