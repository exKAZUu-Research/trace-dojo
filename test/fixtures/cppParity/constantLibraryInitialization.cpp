#include <algorithm>
#include <array>
#include <iostream>
#include <string>
#include <utility>

void read();
int early = (read(), 0);
const std::pair<int, int> original{7, 8};
std::pair<int, int> copied = original;
std::pair<int, int> made = std::make_pair(5, 6);
std::pair<long, long> converted = std::make_pair(3, 4);
std::pair<int, int> selected = std::max(std::make_pair(2, 9), std::make_pair(4, 1));
std::string text = "abc";
std::string repeated(5, 'x');
std::string counted("a\0bc", 4);
std::string listed{'y', 'z'};
const std::array<int, 2> originalArray{3, 4};
std::array<int, 2> copiedArray = originalArray;
std::pair<std::string, int> textPair{"ab", 2};
auto madeTextPair = std::make_pair(std::string("cd"), 3);
const std::string prefix = std::string("ab") + "c";
const std::string copiedPrefix = prefix;
std::string expanded = 'x' + (std::string("ab") + "c") + std::string("yz");

void read() {
  std::cout << copied.first << made.first << converted.first << selected.first
            << text.size() << repeated.size() << counted.size() << listed.size()
            << copiedArray[1] << textPair.second << madeTextPair.second
            << copiedPrefix.size() << expanded.size() << '\n';
}

int calls = 0;
void touch() { ++calls; }
int* pointer = (touch(), nullptr);

int main() { std::cout << calls << ':' << (pointer == nullptr) << '\n'; }
