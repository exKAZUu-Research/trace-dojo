#include <iostream>
#include <limits>
#include <sstream>
#include <string>
int main() {
  std::istringstream cin("42 rest\nhello world\nabcdefg\nxy;zzzQ\nlast\n");
  int n;
  cin >> n;
  cin.ignore(std::numeric_limits<std::streamsize>::max(), '\n');
  std::string line;
  std::getline(cin, line);
  std::cout << n << "[" << line << "]\n";
  char buf[5];
  cin.getline(buf, 5);
  std::cout << buf << " " << cin.fail() << " " << cin.gcount() << "\n";
  cin.clear();
  cin.get(buf, 4, ';');
  std::cout << buf << " " << (char)cin.peek() << "\n";
  cin.ignore();
  char data[3];
  cin.read(data, 3);
  std::cout << std::string(data, 3) << cin.gcount() << "\n";
  int c;
  int count = 0;
  while ((c = cin.get()) != EOF) ++count;
  std::cout << count << cin.eof() << cin.fail() << "\n";
  cin.clear();
  cin.unget();
  std::cout << (char)cin.get() << cin.tellg() << "\n";
}
