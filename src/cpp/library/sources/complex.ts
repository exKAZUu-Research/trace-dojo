import type { LibrarySource } from '../librarySources';
import { TYPE_TRAITS } from './typeTraits';

/** `<complex>`, as libc++ computes it for finite values. */
export const COMPLEX: LibrarySource = {
  names: [
    'complex',
    'real',
    'imag',
    'abs',
    'arg',
    'norm',
    'conj',
    'proj',
    'polar',
    'exp',
    'log',
    'log10',
    'pow',
    'sqrt',
    'sin',
    'cos',
    'tan',
    'sinh',
    'cosh',
    'tanh',
    'literals',
    'complex_literals',
  ],
  uses: [TYPE_TRAITS],
  source: String.raw`
template <class T>
class complex {
  T __re;
  T __im;

public:
  using value_type = T;
  constexpr complex(const T& re = T(), const T& im = T()) : __re(re), __im(im) {}
  template <class U>
  constexpr explicit(sizeof(U) > sizeof(T)) complex(const complex<U>& other) : __re(other.real()), __im(other.imag()) {}

  constexpr T real() const { return __re; }
  constexpr T imag() const { return __im; }
  constexpr void real(T re) { __re = re; }
  constexpr void imag(T im) { __im = im; }

  constexpr complex& operator=(const T& re) {
    __re = re;
    __im = T();
    return *this;
  }
  constexpr complex& operator+=(const T& re) {
    __re += re;
    return *this;
  }
  constexpr complex& operator-=(const T& re) {
    __re -= re;
    return *this;
  }
  constexpr complex& operator*=(const T& re) {
    __re *= re;
    __im *= re;
    return *this;
  }
  constexpr complex& operator/=(const T& re) {
    __re /= re;
    __im /= re;
    return *this;
  }
  template <class U>
  constexpr complex& operator=(const complex<U>& other) {
    __re = other.real();
    __im = other.imag();
    return *this;
  }
  template <class U>
  constexpr complex& operator+=(const complex<U>& other) {
    __re += other.real();
    __im += other.imag();
    return *this;
  }
  template <class U>
  constexpr complex& operator-=(const complex<U>& other) {
    __re -= other.real();
    __im -= other.imag();
    return *this;
  }
  template <class U>
  constexpr complex& operator*=(const complex<U>& other) {
    *this = *this * complex(other.real(), other.imag());
    return *this;
  }
  template <class U>
  constexpr complex& operator/=(const complex<U>& other) {
    *this = *this / complex(other.real(), other.imag());
    return *this;
  }
};

template <class T>
constexpr complex<T> operator+(const complex<T>& x, const complex<T>& y) {
  return complex<T>(x.real() + y.real(), x.imag() + y.imag());
}
template <class T>
constexpr complex<T> operator+(const complex<T>& x, const T& y) {
  return complex<T>(x.real() + y, x.imag());
}
template <class T>
constexpr complex<T> operator+(const T& x, const complex<T>& y) {
  return complex<T>(x + y.real(), y.imag());
}
template <class T>
constexpr complex<T> operator-(const complex<T>& x, const complex<T>& y) {
  return complex<T>(x.real() - y.real(), x.imag() - y.imag());
}
template <class T>
constexpr complex<T> operator-(const complex<T>& x, const T& y) {
  return complex<T>(x.real() - y, x.imag());
}
template <class T>
constexpr complex<T> operator-(const T& x, const complex<T>& y) {
  return complex<T>(x - y.real(), -y.imag());
}
template <class T>
constexpr complex<T> operator*(const complex<T>& z, const complex<T>& w) {
  T a = z.real();
  T b = z.imag();
  T c = w.real();
  T d = w.imag();
  T ac = a * c;
  T bd = b * d;
  T ad = a * d;
  T bc = b * c;
  T x = ac - bd;
  T y = ad + bc;
  return complex<T>(x, y);
}
template <class T>
constexpr complex<T> operator*(const complex<T>& x, const T& y) {
  return complex<T>(x.real() * y, x.imag() * y);
}
template <class T>
constexpr complex<T> operator*(const T& x, const complex<T>& y) {
  return complex<T>(x * y.real(), x * y.imag());
}
template <class T>
constexpr complex<T> operator/(const complex<T>& z, const complex<T>& w) {
  int ilogbw = 0;
  T a = z.real();
  T b = z.imag();
  T c = w.real();
  T d = w.imag();
  T logbw = std::logb(std::fmax(std::fabs(c), std::fabs(d)));
  if (std::isfinite(logbw)) {
    ilogbw = static_cast<int>(logbw);
    c = std::scalbn(c, -ilogbw);
    d = std::scalbn(d, -ilogbw);
  }
  T denom = c * c + d * d;
  T x = std::scalbn((a * c + b * d) / denom, -ilogbw);
  T y = std::scalbn((b * c - a * d) / denom, -ilogbw);
  return complex<T>(x, y);
}
template <class T>
constexpr complex<T> operator/(const complex<T>& x, const T& y) {
  return complex<T>(x.real() / y, x.imag() / y);
}
template <class T>
constexpr complex<T> operator/(const T& x, const complex<T>& y) {
  return complex<T>(x) / y;
}
template <class T>
constexpr complex<T> operator+(const complex<T>& x) {
  return x;
}
template <class T>
constexpr complex<T> operator-(const complex<T>& x) {
  return complex<T>(-x.real(), -x.imag());
}
template <class T>
constexpr bool operator==(const complex<T>& x, const complex<T>& y) {
  return x.real() == y.real() && x.imag() == y.imag();
}
template <class T>
constexpr bool operator==(const complex<T>& x, const T& y) {
  return x.real() == y && x.imag() == 0;
}

template <class T>
std::ostream& operator<<(std::ostream& out, const complex<T>& x) {
  std::ostringstream text;
  text.flags(out.flags());
  text.precision(out.precision());
  text << '(' << x.real() << ',' << x.imag() << ')';
  return out << text.str();
}
template <class T>
std::istream& operator>>(std::istream& in, complex<T>& x) {
  T re = T();
  T im = T();
  char c = 0;
  in >> std::ws;
  if (in.peek() == '(') {
    in.get(c);
    in >> re >> std::ws;
    if (in.peek() == ',') {
      in.get(c);
      in >> im >> std::ws;
    }
    if (in.peek() == ')') in.get(c);
    else in.setstate(std::ios_base::failbit);
  } else {
    in >> re;
  }
  if (!in.fail()) x = complex<T>(re, im);
  return in;
}

template <class T>
constexpr T real(const complex<T>& x) {
  return x.real();
}
template <class T>
constexpr T imag(const complex<T>& x) {
  return x.imag();
}
template <class T>
T abs(const complex<T>& x) {
  return std::hypot(x.real(), x.imag());
}
template <class T>
T arg(const complex<T>& x) {
  return std::atan2(x.imag(), x.real());
}
template <class T>
constexpr T norm(const complex<T>& x) {
  if (std::isinf(x.real())) return std::fabs(x.real());
  if (std::isinf(x.imag())) return std::fabs(x.imag());
  return x.real() * x.real() + x.imag() * x.imag();
}
template <class T>
constexpr complex<T> conj(const complex<T>& x) {
  return complex<T>(x.real(), -x.imag());
}
template <class T>
complex<T> proj(const complex<T>& x) {
  if (std::isinf(x.real()) || std::isinf(x.imag()))
    return complex<T>(INFINITY, std::copysign(T(0), x.imag()));
  return x;
}
template <class T>
complex<T> polar(const T& rho, const T& theta = T()) {
  if (std::isnan(rho) || std::signbit(rho)) return complex<T>(T(NAN), T(NAN));
  T x = rho * std::cos(theta);
  if (std::isnan(x)) x = 0;
  T y = rho * std::sin(theta);
  if (std::isnan(y)) y = 0;
  return complex<T>(x, y);
}
template <class T>
complex<T> exp(const complex<T>& x) {
  T i = x.imag();
  if (i == 0) return complex<T>(std::exp(x.real()), std::copysign(T(0), x.imag()));
  T e = std::exp(x.real());
  return complex<T>(e * std::cos(i), e * std::sin(i));
}
template <class T>
complex<T> log(const complex<T>& x) {
  return complex<T>(std::log(std::abs(x)), std::arg(x));
}
template <class T>
complex<T> log10(const complex<T>& x) {
  return std::log(x) / std::log(T(10));
}
template <class T>
complex<T> sqrt(const complex<T>& x) {
  if (std::isinf(x.imag())) return complex<T>(T(INFINITY), x.imag());
  return std::polar(std::sqrt(std::abs(x)), std::arg(x) / T(2));
}
template <class T>
complex<T> pow(const complex<T>& x, const complex<T>& y) {
  return std::exp(y * std::log(x));
}
template <class T>
complex<T> pow(const complex<T>& x, const T& y) {
  return std::pow(x, complex<T>(y));
}
template <class T>
complex<T> pow(const T& x, const complex<T>& y) {
  return std::pow(complex<T>(x), y);
}
template <class T>
complex<T> pow(const complex<T>& x, int y) {
  return std::pow(x, complex<T>(static_cast<T>(y)));
}
template <class T>
complex<T> sinh(const complex<T>& x) {
  if (x.imag() == 0) return complex<T>(std::sinh(x.real()), x.imag());
  return complex<T>(std::sinh(x.real()) * std::cos(x.imag()), std::cosh(x.real()) * std::sin(x.imag()));
}
template <class T>
complex<T> cosh(const complex<T>& x) {
  if (x.imag() == 0) return complex<T>(std::cosh(x.real()), x.imag() * x.real());
  return complex<T>(std::cosh(x.real()) * std::cos(x.imag()), std::sinh(x.real()) * std::sin(x.imag()));
}
template <class T>
complex<T> tanh(const complex<T>& x) {
  if (x.imag() == 0) return complex<T>(std::tanh(x.real()), x.imag());
  T twiceRe(T(2) * x.real());
  T twiceIm(T(2) * x.imag());
  T d(std::cosh(twiceRe) + std::cos(twiceIm));
  T sinhTwiceRe(std::sinh(twiceRe));
  if (std::isinf(sinhTwiceRe) && std::isinf(d))
    return complex<T>(sinhTwiceRe > T(0) ? T(1) : T(-1), std::sin(twiceIm) > T(0) ? T(0) : T(-0.));
  return complex<T>(sinhTwiceRe / d, std::sin(twiceIm) / d);
}
template <class T>
complex<T> sin(const complex<T>& x) {
  complex<T> z = std::sinh(complex<T>(-x.imag(), x.real()));
  return complex<T>(z.imag(), -z.real());
}
template <class T>
complex<T> cos(const complex<T>& x) {
  return std::cosh(complex<T>(-x.imag(), x.real()));
}
template <class T>
complex<T> tan(const complex<T>& x) {
  complex<T> z = std::tanh(complex<T>(-x.imag(), x.real()));
  return complex<T>(z.imag(), -z.real());
}

// The compiler makes the imaginary literals (2.5i), whose suffixes the grammar reads as the library's.
inline namespace literals {
inline namespace complex_literals {}
}  // namespace literals
`,
};
