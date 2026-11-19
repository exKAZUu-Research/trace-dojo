#include <algorithm>
#include <cmath>
#include <ctime>
#include <iomanip>
#include <iostream>

struct time { int value; };
struct log { int value; };
int data = 2;
using namespace std;

int left(int value) { return 2 * value + 1; }
int fixed(int value) { return value + 1; }
int endl(int value) { return value + 2; }
int merge(int value) { return value + 3; }

int main() {
  struct time first{3};
  struct log second{4};
  std::left(std::cout);
  cout << setw(3) << first.value << left(second.value) << ' '
       << fixed(::data) << ' ' << endl(3) << ' ' << merge(3) << endl;
  cout << std::right << setw(3) << 1 << ' ' << log(1.0) << '\n';
}
