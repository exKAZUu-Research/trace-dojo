#include <complex>
#include <iomanip>
#include <iostream>
#include <sstream>
using namespace std::complex_literals;
int main() {
  std::complex<double> a(3.0, 4.0), b(1.0, -2.0);
  std::cout << a << " " << b << "\n";
  std::cout << a + b << a - b << a * b << a / b << "\n";
  std::cout << std::abs(a) << " " << std::arg(a) << " " << std::norm(a) << " " << std::conj(a) << "\n";
  std::cout << std::exp(b) << std::log(a) << std::sqrt(b) << std::pow(a, 2.0) << std::pow(a, b) << "\n";
  std::cout << std::polar(2.0, 0.5) << std::sin(a) << std::cos(b) << std::tan(b) << "\n";
  std::complex<double> c = 2.0 + 3.0i;
  c *= 2.0;
  c += a;
  std::cout << c << (c == std::complex<double>(7, 10)) << c.real() << c.imag() << "\n";
  std::cout << std::fixed << std::setprecision(2) << a / 3.0 << "\n";
  std::complex<float> f(1.5f, -0.5f);
  std::cout << f * f << " " << std::abs(f) << "\n";
  std::istringstream in("(1.5,2.5) 7");
  std::complex<double> r1, r2;
  in >> r1 >> r2;
  std::cout << r1 << r2 << "\n";
  std::complex<int> gi(2, 3);
  std::cout << gi * gi << "\n";
}
