#include <array>
#include <iostream>
#include <utility>
#include <vector>
using namespace std;

int main() {
  std::cout << sizeof(vector<int>) << ' ' << sizeof(pair<int, int>) << ' '
            << sizeof(vector<vector<int>>) << ' ' << sizeof(array<int, 4>) << ' '
            << sizeof(std::vector<int>) << ' ' << sizeof(vector<int>*) << '\n';
}
