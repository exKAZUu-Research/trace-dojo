#include <algorithm>
#include <cmath>
#include <ctime>
#include <iomanip>
#include <iostream>

struct time {
  int value;
  time(int n);
  time twice() const;
};
time::time(int n) : value(n) {}
struct time time::twice() const { time copy{2 * value}; return copy; }
struct clock { static int count; };
int clock::count = 8;
struct timer : time {
  timer(int n) : time(n) {}
  time elapsed() const { return twice(); }
};
struct log { int value; };
int data = 2;
int id = 3;
int target = 4;
int insert = 5;
struct handle { int value; };
using namespace std;

int left(int value) { return 2 * value + 1; }
int fixed(int value) { return value + 1; }
int endl(int value) { return value + 2; }
int merge(int value) { return value + 3; }
int sort(int value) { return value + 4; }
using std::sort;

int main() {
  struct time first{3};
  struct log second{4};
  std::left(std::cout);
  cout << setw(3) << first.value << left(second.value) << ' '
       << fixed(::data) << ' ' << endl(3) << ' ' << merge(3) << endl;
  cout << std::right << setw(3) << 1 << ' ' << log(1.0) << '\n';
  handle plain{6};
  cout << id << target << insert << plain.value << '\n';
  timer elapsed(7);
  cout << first.twice().value << ' ' << elapsed.elapsed().value << ' ' << clock::count << '\n';
  int values[] = {5, 3};
  sort(values, values + 2);
  cout << sort(values[0]) << '\n';
}
