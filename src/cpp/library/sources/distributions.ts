import type { LibrarySource } from '../librarySources';
import { INITIALIZER_LIST } from './initializerList';

/**
 * The distributions of `<random>` besides the uniform ones, which draw from `std::uniform_real_distribution` as libc++
 * does, so that an engine gives the same numbers as with clang++.
 */
export const DISTRIBUTIONS: LibrarySource = {
  names: [
    'normal_distribution',
    'bernoulli_distribution',
    'exponential_distribution',
    'discrete_distribution',
    'poisson_distribution',
    'lognormal_distribution',
    'cauchy_distribution',
    'weibull_distribution',
    'extreme_value_distribution',
    'binomial_distribution',
    'geometric_distribution',
    'negative_binomial_distribution',
  ],
  uses: [INITIALIZER_LIST],
  source: String.raw`
template <class R = double>
class normal_distribution {
  R __mean;
  R __stddev;
  R __saved = 0;
  bool __has_saved = false;

public:
  using result_type = R;
  explicit normal_distribution(R mean = 0, R stddev = 1) : __mean(mean), __stddev(stddev) {}
  void reset() { __has_saved = false; }
  R mean() const { return __mean; }
  R stddev() const { return __stddev; }
  template <class G>
  R operator()(G& g) {
    R value;
    if (__has_saved) {
      __has_saved = false;
      value = __saved;
    } else {
      std::uniform_real_distribution<R> uniform(-1, 1);
      R u;
      R v;
      R s;
      do {
        u = uniform(g);
        v = uniform(g);
        s = u * u + v * v;
      } while (s > 1 || s == 0);
      R factor = std::sqrt(-2 * std::log(s) / s);
      __saved = v * factor;
      __has_saved = true;
      value = u * factor;
    }
    return value * __stddev + __mean;
  }
};

class bernoulli_distribution {
  double __p;

public:
  using result_type = bool;
  explicit bernoulli_distribution(double p = 0.5) : __p(p) {}
  void reset() {}
  double p() const { return __p; }
  template <class G>
  bool operator()(G& g) {
    std::uniform_real_distribution<double> uniform;
    return uniform(g) < __p;
  }
};

template <class R = double>
class exponential_distribution {
  R __lambda;

public:
  using result_type = R;
  explicit exponential_distribution(R lambda = 1) : __lambda(lambda) {}
  void reset() {}
  R lambda() const { return __lambda; }
  template <class G>
  R operator()(G& g) {
    std::uniform_real_distribution<R> uniform;
    return -std::log(R(1) - uniform(g)) / __lambda;
  }
};

template <class R = double>
class lognormal_distribution {
  normal_distribution<R> __normal;

public:
  using result_type = R;
  explicit lognormal_distribution(R m = 0, R s = 1) : __normal(m, s) {}
  void reset() { __normal.reset(); }
  R m() const { return __normal.mean(); }
  R s() const { return __normal.stddev(); }
  template <class G>
  R operator()(G& g) {
    return std::exp(__normal(g));
  }
};

template <class R = double>
class cauchy_distribution {
  R __a;
  R __b;

public:
  using result_type = R;
  explicit cauchy_distribution(R a = 0, R b = 1) : __a(a), __b(b) {}
  void reset() {}
  template <class G>
  R operator()(G& g) {
    std::uniform_real_distribution<R> uniform;
    return __a + __b * std::tan(3.1415926535897932384626433832795 * uniform(g));
  }
};

template <class R = double>
class weibull_distribution {
  R __a;
  R __b;

public:
  using result_type = R;
  explicit weibull_distribution(R a = 1, R b = 1) : __a(a), __b(b) {}
  void reset() {}
  template <class G>
  R operator()(G& g) {
    return __b * std::pow(exponential_distribution<R>()(g), 1 / __a);
  }
};

template <class R = double>
class extreme_value_distribution {
  R __a;
  R __b;

public:
  using result_type = R;
  explicit extreme_value_distribution(R a = 0, R b = 1) : __a(a), __b(b) {}
  void reset() {}
  template <class G>
  R operator()(G& g) {
    std::uniform_real_distribution<R> uniform;
    return __a - __b * std::log(-std::log(1 - uniform(g)));
  }
};

template <class I = int>
class discrete_distribution {
  std::vector<double> __cumulative;

  template <class It>
  void __init(It first, It last) {
    std::vector<double> weights(first, last);
    if (weights.size() <= 1) return;
    double total = 0;
    for (double weight : weights) total += weight;
    double sum = 0;
    for (unsigned long i = 0; i + 1 < weights.size(); ++i) {
      sum += weights[i] / total;
      __cumulative.push_back(sum);
    }
  }

public:
  using result_type = I;
  discrete_distribution() {}
  discrete_distribution(std::initializer_list<double> weights) { __init(weights.begin(), weights.end()); }
  template <class It>
  discrete_distribution(It first, It last) {
    __init(first, last);
  }
  void reset() {}
  template <class G>
  I operator()(G& g) {
    std::uniform_real_distribution<double> uniform;
    double u = uniform(g);
    unsigned long index = 0;
    while (index < __cumulative.size() && !(u < __cumulative[index])) ++index;
    return static_cast<I>(index);
  }
};

template <class I = int>
class poisson_distribution {
  double __mean;
  double __limit;

public:
  using result_type = I;
  explicit poisson_distribution(double mean = 1) : __mean(mean), __limit(std::exp(-mean)) {}
  void reset() {}
  double mean() const { return __mean; }
  template <class G>
  I operator()(G& g) {
    if (__mean >= 10) throw std::runtime_error("平均が 10 以上の poisson_distribution は、この採点環境では使えません。");
    std::uniform_real_distribution<double> uniform;
    I count = 0;
    for (double p = uniform(g); p > __limit; ++count) p *= uniform(g);
    return count;
  }
};

// libc++ takes lgamma(n + 1), which the interpreter leaves out, as log(n!) for the whole numbers it takes.
inline double __log_factorial(double n) {
  double sum = 0;
  for (double k = 2; k <= n; ++k) sum += std::log(k);
  return sum;
}

template <class I = int>
class binomial_distribution {
  I __t;
  double __p;
  double __pr = 0;
  double __odds = 0;
  I __r0 = 0;

public:
  using result_type = I;
  explicit binomial_distribution(I t = 1, double p = 0.5) : __t(t), __p(p) {
    if (0 < p && p < 1) {
      __r0 = static_cast<I>((t + 1) * p);
      __pr = std::exp(__log_factorial(t) - __log_factorial(__r0) - __log_factorial(t - __r0) + __r0 * std::log(p) +
                      (t - __r0) * std::log(1 - p));
      __odds = p / (1 - p);
    }
  }
  void reset() {}
  I t() const { return __t; }
  double p() const { return __p; }
  template <class G>
  I operator()(G& g) {
    if (__t == 0 || __p == 0) return 0;
    if (__p == 1) return __t;
    std::uniform_real_distribution<double> uniform;
    double u = uniform(g) - __pr;
    if (u < 0) return __r0;
    double pu = __pr;
    double pd = pu;
    I ru = __r0;
    I rd = ru;
    while (true) {
      bool done = true;
      if (rd >= 1) {
        pd *= rd / (__odds * (__t - rd + 1));
        u -= pd;
        done = false;
        if (u < 0) return rd - 1;
      }
      if (rd != 0) --rd;
      ++ru;
      if (ru <= __t) {
        pu *= (__t - ru + 1) * __odds / ru;
        u -= pu;
        done = false;
        if (u < 0) return ru;
      }
      if (done) return 0;
    }
  }
};

template <class I = int>
class negative_binomial_distribution {
  I __k;
  double __p;

public:
  using result_type = I;
  explicit negative_binomial_distribution(I k = 1, double p = 0.5) : __k(k), __p(p) {}
  void reset() {}
  I k() const { return __k; }
  double p() const { return __p; }
  template <class G>
  I operator()(G& g) {
    if (__k > 21 * __p) throw std::runtime_error("成功の確率が小さい negative_binomial_distribution・geometric_distribution は、この採点環境では使えません。");
    bernoulli_distribution trial(__p);
    I failures = 0;
    I successes = 0;
    while (successes < __k) {
      if (trial(g)) ++successes;
      else ++failures;
    }
    return failures;
  }
};

template <class I = int>
class geometric_distribution {
  double __p;

public:
  using result_type = I;
  explicit geometric_distribution(double p = 0.5) : __p(p) {}
  void reset() {}
  double p() const { return __p; }
  template <class G>
  I operator()(G& g) {
    return negative_binomial_distribution<I>(1, __p)(g);
  }
};
`,
};
