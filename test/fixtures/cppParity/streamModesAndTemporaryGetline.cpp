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

  int index = 0;
  int values[] = {7, 8, 9};
  std::istringstream empty("");
  empty >> values[index++];
  std::istringstream failed("x");
  int ignored = 1;
  failed >> ignored;
  failed >> values[index++];
  std::string words[] = {"kept"};
  int wordIndex = 0;
  failed >> words[wordIndex++];
  std::cout << index << values[0] << values[1] << ' ' << wordIndex << words[0] << '\n';

  std::istringstream ready("45");
  ready >> values[index++];
  std::cout << index << ' ' << values[2] << '\n';
}
