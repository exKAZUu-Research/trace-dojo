#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>

int main() {
  std::ostringstream append("start", std::ios_base::app);
  std::ostringstream atEnd("start", std::ios::ate);
  std::ostringstream overwrite("start", std::ios_base::trunc);
  append << 'X';
  atEnd << 'Y';
  overwrite << 'Z';
  std::cout << append.str() << ' ' << atEnd.str() << ' ' << overwrite.str() << '\n';

  std::string word;
  std::getline(std::istringstream("first;second"), word, ';');
  auto width = std::setw(6);
  auto copy = width;
  std::cout << copy << word << '\n';
}
