#include <cmath>
#include <iostream>
using namespace std;

double pow(double, double) { return -1; }
double sin(double) { return -2; }
double exp(double) { return -3; }
double sqrt(double) { return -4; }
double atan2(double, double) { return -5; }
float sinf(float) { return -6; }

int main(int argc, char** argv) {
  int x = argc + 1;
  int y = argc + 2;
  std::cout << pow(x, y) << ' ' << std::pow(x, y) << ' ' << ::pow(x, y) << ' '
            << pow(float(x), float(y)) << '\n';
  std::cout << sin(x) << ' ' << sin(float(x)) << ' ' << exp(x) << ' '
            << atan2(x, 2.0) << ' ' << cos(y) << '\n';
  std::cout << sqrt(4) << ' ' << ::sqrt(4) << ' ' << sqrt(4.0) << '\n';
}

double cos(double) { return -7; }
