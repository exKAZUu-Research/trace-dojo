#include <cstdio>
#include <vector>

int main() {
  std::printf("%a %a %a\n", 1.0000000596046447f, 1.000000059604644775390625f, 1.0000000596046448f);
  std::printf("%a %a %a\n", 0.5000000298023224f, 1.0000001788139343f, .125e+1f);
  std::printf("%a %a %a\n", 7.006492321624085e-46f, 7.006492321624086e-46f, 3.4028235e38f);
  constexpr long double constant = 1.25L;
  double scalar{constant};
  std::vector<double> values{constant};
  long double source = constant;
  double ordinary = source;
  float rounded{3.4028235e38};
  std::printf("%g %g %g %a\n", scalar, values[0], ordinary, rounded);
}
