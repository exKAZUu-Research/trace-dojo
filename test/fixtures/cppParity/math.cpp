#include <iostream>
#include <cmath>
#include <cstdlib>
#include <climits>
#include <limits>
#include <iomanip>
using namespace std;
int main() {
  cout << sqrt(2) << " " << pow(2, 10) << " " << pow(2.5, 3) << " " << abs(-5) << " " << abs(-2.5) << " " << fabs(-3.0) << endl;
  cout << floor(2.7) << " " << ceil(2.1) << " " << round(2.5) << " " << round(-2.5) << " " << trunc(-2.7) << " " << fmod(7.5, 2) << endl;
  cout << sin(1.0) << " " << cos(1.0) << " " << tan(0.5) << " " << atan2(1, 1) << " " << exp(1) << " " << log(10) << " " << log10(1000) << " " << log2(8) << endl;
  cout << hypot(3, 4) << " " << cbrt(27) << " " << fmax(1, 2) << " " << fmin(1, 2) << " " << M_PI << endl;
  cout << INT_MAX << " " << INT_MIN << " " << LLONG_MAX << " " << numeric_limits<int>::max() << " " << numeric_limits<double>::epsilon() << endl;
  cout << isnan(sqrt(-1.0)) << " " << isinf(1.0 / 0) << endl;
  srand(42); for (int i = 0; i < 5; i++) cout << rand() % 100 << " ";
  cout << endl;
  srand(1); cout << rand() << " " << RAND_MAX << endl;
  cout << setprecision(15) << sqrt(3.0) << " " << pow(10, -3) << " " << exp(0.5) << endl;
  float f = sqrt(2.0f); cout << f << " " << sqrt(2.0f) * 2 << endl;
  int big = INT_MAX; cout << (long long)big + 1 << endl;
  cout << 17 / 5 << " " << 17 % -5 << " " << abs(-17) % 5 << endl;
}
