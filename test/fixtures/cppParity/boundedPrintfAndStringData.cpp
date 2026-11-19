#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>

int main() {
  char word[3] = {'a', 'b', 'c'};
  int count = -1;
  long wide = -1;
  char output[10];
  std::snprintf(output, sizeof(output), "[%.*s%n]%ln", 3, word, &count, &wide);
  std::cout << output << ' ' << count << ' ' << wide << '\n';

  std::string s = "cat";
  const char* view = s.c_str();
  char* data = s.data();
  s[0] = 'b';
  data[2] = 'g';
  std::cout << view << ' ' << (view == &s[0]) << ' ' << (view[s.size()] == '\0') << '\n';

  char buffer[] = "cat";
  char* match = std::strchr(buffer, 'a');
  *match = 'u';
  std::cout << buffer << ' ' << std::strstr("prefix", "fix") << '\n';
}
