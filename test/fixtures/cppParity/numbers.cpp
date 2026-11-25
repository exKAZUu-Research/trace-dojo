#include <iostream>
#include <iomanip>
#include <numbers>
#include <cmath>
using namespace std;
int main() {
  cout << setprecision(17) << std::numbers::pi << " " << numbers::e << " " << numbers::sqrt2 << "\n";
  cout << std::numbers::pi_v<float> << " " << numbers::phi << "\n";
  double r = 2;
  cout << numbers::pi * r * r << " " << std::sin(numbers::pi / 2) << "\n";
  using namespace std::numbers;
  cout << ln2 << " " << egamma << "\n";
}
