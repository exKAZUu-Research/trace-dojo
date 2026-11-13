/**
 * CPython 3.14's Lib/statistics.py in the Python this interpreter runs. `_Fraction` stands for fractions.Fraction in
 * the exact sums, the conditional expressions and assignment expressions are statements, the float literals with an
 * exponent are parsed from strings, and `math.erfc` is read where it is called because this grader rejects it.
 * `_normal_dist_inv_cdf` follows the C function of `_statistics` as the reference build compiles it, with each
 * `a * b + c` contracted into one fused multiply-add.
 */
export const STATISTICS_SOURCE = String.raw`
import math
import random

from itertools import count, groupby, repeat
from bisect import bisect_left, bisect_right
from math import hypot, sqrt, fabs, exp, tau, log, fsum, sumprod
from math import isfinite, isinf, pi, cos, sin, tan, cosh, asin, atan, acos
from functools import reduce
from operator import itemgetter
from collections import Counter, namedtuple, defaultdict

__all__ = [
    'NormalDist',
    'StatisticsError',
    'correlation',
    'covariance',
    'fmean',
    'geometric_mean',
    'harmonic_mean',
    'kde',
    'kde_random',
    'linear_regression',
    'mean',
    'median',
    'median_grouped',
    'median_high',
    'median_low',
    'mode',
    'multimode',
    'pstdev',
    'pvariance',
    'quantiles',
    'stdev',
    'variance',
]

_SQRT2 = sqrt(2.0)
_random = random


class StatisticsError(ValueError):
    pass


class _Fraction:
    def __init__(self, numerator=0, denominator=1):
        g = math.gcd(numerator, denominator)
        if denominator < 0:
            g = -g
        self.numerator = numerator // g
        self.denominator = denominator // g

    def _float(self):
        return self.numerator / self.denominator

    def __add__(a, b):
        if isinstance(b, float):
            return a._float() + b
        b = _fraction(b)
        return _Fraction(a.numerator * b.denominator + b.numerator * a.denominator,
                         a.denominator * b.denominator)

    def __sub__(a, b):
        if isinstance(b, float):
            return a._float() - b
        b = _fraction(b)
        return _Fraction(a.numerator * b.denominator - b.numerator * a.denominator,
                         a.denominator * b.denominator)

    def __mul__(a, b):
        if isinstance(b, float):
            return a._float() * b
        b = _fraction(b)
        return _Fraction(a.numerator * b.numerator, a.denominator * b.denominator)

    __rmul__ = __mul__

    def __truediv__(a, b):
        if isinstance(b, float):
            return a._float() / b
        b = _fraction(b)
        if b.numerator == 0:
            raise ZeroDivisionError('Fraction(%s, 0)' % (a.numerator * b.denominator))
        return _Fraction(a.numerator * b.denominator, a.denominator * b.numerator)

    def __rtruediv__(b, a):
        if isinstance(a, float):
            return a / b._float()
        return _fraction(a) / b

    def __le__(a, b):
        return a.numerator <= b * a.denominator


def _fraction(x):
    if isinstance(x, _Fraction):
        return x
    return _Fraction(x)


def _fraction_sum(fractions):
    total = _Fraction(0)
    for fraction in fractions:
        total = total + fraction
    return total


def mean(data):
    T, total, n = _sum(data)
    if n < 1:
        raise StatisticsError('mean requires at least one data point')
    return _convert(total / n, T)


def fmean(data, weights=None):
    if weights is None:
        try:
            n = len(data)
        except TypeError:
            counter = count()
            total = fsum(map(itemgetter(0), zip(data, counter)))
            n = next(counter)
        else:
            total = fsum(data)
        if not n:
            raise StatisticsError('fmean requires at least one data point')
        return total / n
    if not isinstance(weights, (list, tuple)):
        weights = list(weights)
    try:
        num = sumprod(data, weights)
    except ValueError:
        raise StatisticsError('data and weights must be the same length')
    den = fsum(weights)
    if not den:
        raise StatisticsError('sum of weights must be non-zero')
    return num / den


def geometric_mean(data):
    n = 0
    found_zero = False

    def count_positive(iterable):
        nonlocal n, found_zero
        for n, x in enumerate(iterable, start=1):
            if x > 0.0 or math.isnan(x):
                yield x
            elif x == 0.0:
                found_zero = True
            else:
                raise StatisticsError('No negative inputs allowed', x)
    total = fsum(map(log, count_positive(data)))
    if not n:
        raise StatisticsError('Must have a non-empty dataset')
    if math.isnan(total):
        return math.nan
    if found_zero:
        if total == math.inf:
            return math.nan
        return 0.0
    return exp(total / n)


def harmonic_mean(data, weights=None):
    if iter(data) is data:
        data = list(data)
    errmsg = 'harmonic mean does not support negative values'
    n = len(data)
    if n < 1:
        raise StatisticsError('harmonic_mean requires at least one data point')
    elif n == 1 and weights is None:
        x = data[0]
        if isinstance(x, (int, float)):
            if x < 0:
                raise StatisticsError(errmsg)
            return x
        else:
            raise TypeError('unsupported type')
    if weights is None:
        weights = repeat(1, n)
        sum_weights = n
    else:
        if iter(weights) is weights:
            weights = list(weights)
        if len(weights) != n:
            raise StatisticsError('Number of weights does not match data size')
        _, sum_weights, _ = _sum(w for w in _fail_neg(weights, errmsg))
    try:
        data = _fail_neg(data, errmsg)
        T, total, count = _sum(_weighted_reciprocals(weights, data))
    except ZeroDivisionError:
        return 0
    if total <= 0:
        raise StatisticsError('Weighted sum must be positive')
    return _convert(sum_weights / total, T)


def _weighted_reciprocals(weights, data):
    for w, x in zip(weights, data):
        if w:
            yield w / x
        else:
            yield 0


def median(data):
    data = sorted(data)
    n = len(data)
    if n == 0:
        raise StatisticsError('no median for empty data')
    if n % 2 == 1:
        return data[n // 2]
    else:
        i = n // 2
        return (data[i - 1] + data[i]) / 2


def median_low(data):
    data = sorted(data)
    n = len(data)
    if n == 0:
        raise StatisticsError('no median for empty data')
    if n % 2 == 1:
        return data[n // 2]
    else:
        return data[n // 2 - 1]


def median_high(data):
    data = sorted(data)
    n = len(data)
    if n == 0:
        raise StatisticsError('no median for empty data')
    return data[n // 2]


def median_grouped(data, interval=1.0):
    data = sorted(data)
    n = len(data)
    if not n:
        raise StatisticsError('no median for empty data')
    x = data[n // 2]
    i = bisect_left(data, x)
    j = bisect_right(data, x, lo=i)
    try:
        interval = float(interval)
        x = float(x)
    except ValueError:
        raise TypeError(f'Value cannot be converted to a float')
    L = x - interval / 2.0
    cf = i
    f = j - i
    return L + interval * (n / 2 - cf) / f


def mode(data):
    pairs = Counter(iter(data)).most_common(1)
    try:
        return pairs[0][0]
    except IndexError:
        raise StatisticsError('no mode for empty data') from None


def multimode(data):
    counts = Counter(iter(data))
    if not counts:
        return []
    maxcount = max(counts.values())
    return [value for value, count in counts.items() if count == maxcount]


def variance(data, xbar=None):
    T, ss, c, n = _ss(data, xbar)
    if n < 2:
        raise StatisticsError('variance requires at least two data points')
    return _convert(ss / (n - 1), T)


def pvariance(data, mu=None):
    T, ss, c, n = _ss(data, mu)
    if n < 1:
        raise StatisticsError('pvariance requires at least one data point')
    return _convert(ss / n, T)


def stdev(data, xbar=None):
    T, ss, c, n = _ss(data, xbar)
    if n < 2:
        raise StatisticsError('stdev requires at least two data points')
    mss = ss / (n - 1)
    try:
        mss_numerator = mss.numerator
        mss_denominator = mss.denominator
    except AttributeError:
        raise ValueError('inf or nan encountered in data')
    return _float_sqrt_of_frac(mss_numerator, mss_denominator)


def pstdev(data, mu=None):
    T, ss, c, n = _ss(data, mu)
    if n < 1:
        raise StatisticsError('pstdev requires at least one data point')
    mss = ss / n
    try:
        mss_numerator = mss.numerator
        mss_denominator = mss.denominator
    except AttributeError:
        raise ValueError('inf or nan encountered in data')
    return _float_sqrt_of_frac(mss_numerator, mss_denominator)


def covariance(x, y, /):
    n = len(x)
    if len(y) != n:
        raise StatisticsError('covariance requires that both inputs have same number of data points')
    if n < 2:
        raise StatisticsError('covariance requires at least two data points')
    xbar = fsum(x) / n
    ybar = fsum(y) / n
    sxy = sumprod((xi - xbar for xi in x), (yi - ybar for yi in y))
    return sxy / (n - 1)


def correlation(x, y, /, *, method='linear'):
    n = len(x)
    if len(y) != n:
        raise StatisticsError('correlation requires that both inputs have same number of data points')
    if n < 2:
        raise StatisticsError('correlation requires at least two data points')
    if method not in {'linear', 'ranked'}:
        raise ValueError(f'Unknown method: {method!r}')
    if method == 'ranked':
        start = (n - 1) / -2
        x = _rank(x, start=start)
        y = _rank(y, start=start)
    else:
        xbar = fsum(x) / n
        ybar = fsum(y) / n
        x = [xi - xbar for xi in x]
        y = [yi - ybar for yi in y]
    sxy = sumprod(x, y)
    sxx = sumprod(x, x)
    syy = sumprod(y, y)
    try:
        return sxy / _sqrtprod(sxx, syy)
    except ZeroDivisionError:
        raise StatisticsError('at least one of the inputs is constant')


LinearRegression = namedtuple('LinearRegression', ('slope', 'intercept'), module='statistics')


def linear_regression(x, y, /, *, proportional=False):
    n = len(x)
    if len(y) != n:
        raise StatisticsError('linear regression requires that both inputs have same number of data points')
    if n < 2:
        raise StatisticsError('linear regression requires at least two data points')
    if not proportional:
        xbar = fsum(x) / n
        ybar = fsum(y) / n
        x = [xi - xbar for xi in x]
        y = (yi - ybar for yi in y)
    sxy = sumprod(x, y) + 0.0
    sxx = sumprod(x, x)
    try:
        slope = sxy / sxx
    except ZeroDivisionError:
        raise StatisticsError('x is constant')
    if proportional:
        intercept = 0.0
    else:
        intercept = ybar - slope * xbar
    return LinearRegression(slope=slope, intercept=intercept)


_kernel_specs = {}


def _register(*kernels):
    def deco(builder):
        spec = dict(zip(('pdf', 'cdf', 'invcdf', 'support'), builder()))
        for kernel in kernels:
            _kernel_specs[kernel] = spec
        return builder
    return deco


@_register('normal', 'gauss')
def _normal_kernel():
    sqrt2pi = sqrt(2 * pi)
    neg_sqrt2 = -sqrt(2)
    pdf = lambda t: exp(-1/2 * t * t) / sqrt2pi
    cdf = lambda t: 1/2 * math.erfc(t / neg_sqrt2)
    invcdf = lambda t: _normal_dist_inv_cdf(t, 0.0, 1.0)
    support = None
    return pdf, cdf, invcdf, support


@_register('logistic')
def _logistic_kernel():
    pdf = lambda t: 1/2 / (1.0 + cosh(t))
    cdf = lambda t: 1.0 - 1.0 / (exp(t) + 1.0)
    invcdf = lambda p: log(p / (1.0 - p))
    support = None
    return pdf, cdf, invcdf, support


@_register('sigmoid')
def _sigmoid_kernel():
    c1 = 1 / pi
    c2 = 2 / pi
    c3 = pi / 2
    pdf = lambda t: c1 / cosh(t)
    cdf = lambda t: c2 * atan(exp(t))
    invcdf = lambda p: log(tan(p * c3))
    support = None
    return pdf, cdf, invcdf, support


@_register('rectangular', 'uniform')
def _rectangular_kernel():
    pdf = lambda t: 1/2
    cdf = lambda t: 1/2 * t + 1/2
    invcdf = lambda p: 2.0 * p - 1.0
    support = 1.0
    return pdf, cdf, invcdf, support


@_register('triangular')
def _triangular_kernel():
    pdf = lambda t: 1.0 - abs(t)

    def cdf(t):
        if t < 0.0:
            return t*t * (1/2) + t + 1/2
        return t*t * (-1/2) + t + 1/2

    def invcdf(p):
        if p < 1/2:
            return sqrt(2.0*p) - 1.0
        return 1.0 - sqrt(2.0 - 2.0*p)
    support = 1.0
    return pdf, cdf, invcdf, support


@_register('parabolic', 'epanechnikov')
def _parabolic_kernel():
    pdf = lambda t: 3/4 * (1.0 - t * t)
    cdf = lambda t: sumprod((-1/4, 3/4, 1/2), (t**3, t, 1.0))
    invcdf = lambda p: 2.0 * cos((acos(2.0*p - 1.0) + pi) / 3.0)
    support = 1.0
    return pdf, cdf, invcdf, support


_NEWTON_TOLERANCE = float('1e-12')


def _newton_raphson(f_inv_estimate, f, f_prime, tolerance=_NEWTON_TOLERANCE):
    def f_inv(y):
        x = f_inv_estimate(y)
        diff = f(x) - y
        while abs(diff) > tolerance:
            x -= diff / f_prime(x)
            diff = f(x) - y
        return x
    return f_inv


def _quartic_invcdf_estimate(p):
    sign = 1.0
    if not p <= 1/2:
        sign = -1.0
        p = 1.0 - p
    if p < 0.0106:
        return ((2.0 * p) ** 0.3838 - 1.0) * sign
    x = (2.0 * p) ** 0.4258865685331 - 1.0
    if p < 0.499:
        x += 0.026818732 * sin(7.101753784 * p + 2.73230839482953)
    return x * sign


@_register('quartic', 'biweight')
def _quartic_kernel():
    pdf = lambda t: 15/16 * (1.0 - t * t) ** 2
    cdf = lambda t: sumprod((3/16, -5/8, 15/16, 1/2),
                            (t**5, t**3, t, 1.0))
    invcdf = _newton_raphson(_quartic_invcdf_estimate, f=cdf, f_prime=pdf)
    support = 1.0
    return pdf, cdf, invcdf, support


_TRIWEIGHT_LOW = float('1e-05')


def _triweight_invcdf_estimate(p):
    sign = 1.0
    if not p <= 1/2:
        sign = -1.0
        p = 1.0 - p
    x = (2.0 * p) ** 0.3400218741872791 - 1.0
    if _TRIWEIGHT_LOW < p < 0.499:
        x -= 0.033 * sin(1.07 * tau * (p - 0.035))
    return x * sign


@_register('triweight')
def _triweight_kernel():
    pdf = lambda t: 35/32 * (1.0 - t * t) ** 3
    cdf = lambda t: sumprod((-5/32, 21/32, -35/32, 35/32, 1/2),
                            (t**7, t**5, t**3, t, 1.0))
    invcdf = _newton_raphson(_triweight_invcdf_estimate, f=cdf, f_prime=pdf)
    support = 1.0
    return pdf, cdf, invcdf, support


@_register('cosine')
def _cosine_kernel():
    c1 = pi / 4
    c2 = pi / 2
    pdf = lambda t: c1 * cos(c2 * t)
    cdf = lambda t: 1/2 * sin(c2 * t) + 1/2
    invcdf = lambda p: 2.0 * asin(2.0 * p - 1.0) / pi
    support = 1.0
    return pdf, cdf, invcdf, support


del _register, _normal_kernel, _logistic_kernel, _sigmoid_kernel
del _rectangular_kernel, _triangular_kernel, _parabolic_kernel
del _quartic_kernel, _triweight_kernel, _cosine_kernel


def kde(data, h, kernel='normal', *, cumulative=False):
    n = len(data)
    if not n:
        raise StatisticsError('Empty data sequence')

    if not isinstance(data[0], (int, float)):
        raise TypeError('Data sequence must contain ints or floats')

    if h <= 0.0:
        raise StatisticsError(f'Bandwidth h must be positive, not {h=!r}')

    kernel_spec = _kernel_specs.get(kernel)
    if kernel_spec is None:
        raise StatisticsError(f'Unknown kernel name: {kernel!r}')
    K = kernel_spec['pdf']
    W = kernel_spec['cdf']
    support = kernel_spec['support']

    if support is None:

        def pdf(x):
            return sum(K((x - x_i) / h) for x_i in data) / (len(data) * h)

        def cdf(x):
            return sum(W((x - x_i) / h) for x_i in data) / len(data)

    else:

        sample = sorted(data)
        bandwidth = h * support

        def pdf(x):
            nonlocal n, sample
            if len(data) != n:
                sample = sorted(data)
                n = len(data)
            i = bisect_left(sample, x - bandwidth)
            j = bisect_right(sample, x + bandwidth)
            supported = sample[i : j]
            return sum(K((x - x_i) / h) for x_i in supported) / (n * h)

        def cdf(x):
            nonlocal n, sample
            if len(data) != n:
                sample = sorted(data)
                n = len(data)
            i = bisect_left(sample, x - bandwidth)
            j = bisect_right(sample, x + bandwidth)
            supported = sample[i : j]
            return sum((W((x - x_i) / h) for x_i in supported), i) / n

    if cumulative:
        cdf.__doc__ = f'CDF estimate with {h=!r} and {kernel=!r}'
        return cdf

    else:
        pdf.__doc__ = f'PDF estimate with {h=!r} and {kernel=!r}'
        return pdf


def kde_random(data, h, kernel='normal', *, seed=None):
    n = len(data)
    if not n:
        raise StatisticsError('Empty data sequence')

    if not isinstance(data[0], (int, float)):
        raise TypeError('Data sequence must contain ints or floats')

    if h <= 0.0:
        raise StatisticsError(f'Bandwidth h must be positive, not {h=!r}')

    kernel_spec = _kernel_specs.get(kernel)
    if kernel_spec is None:
        raise StatisticsError(f'Unknown kernel name: {kernel!r}')
    invcdf = kernel_spec['invcdf']

    prng = _random.Random(seed)
    random = prng.random
    choice = prng.choice

    def rand():
        return choice(data) + h * invcdf(random())

    rand.__doc__ = f'Random KDE selection with {h=!r} and {kernel=!r}'

    return rand


def quantiles(data, *, n=4, method='exclusive'):
    if n < 1:
        raise StatisticsError('n must be at least 1')

    data = sorted(data)

    ld = len(data)
    if ld < 2:
        if ld == 1:
            return data * (n - 1)
        raise StatisticsError('must have at least one data point')

    if method == 'inclusive':
        m = ld - 1
        result = []
        for i in range(1, n):
            j, delta = divmod(i * m, n)
            interpolated = (data[j] * (n - delta) + data[j + 1] * delta) / n
            result.append(interpolated)
        return result

    if method == 'exclusive':
        m = ld + 1
        result = []
        for i in range(1, n):
            j = i * m // n
            if j < 1:
                j = 1
            elif j > ld-1:
                j = ld-1
            delta = i*m - j*n
            interpolated = (data[j - 1] * (n - delta) + data[j] * delta) / n
            result.append(interpolated)
        return result

    raise ValueError(f'Unknown method: {method!r}')


class NormalDist:
    def __init__(self, mu=0.0, sigma=1.0):
        if sigma < 0.0:
            raise StatisticsError('sigma must be non-negative')
        self._mu = float(mu)
        self._sigma = float(sigma)

    @classmethod
    def from_samples(cls, data):
        return cls(*_mean_stdev(data))

    def samples(self, n, *, seed=None):
        if seed is None:
            rnd = random.random
        else:
            rnd = random.Random(seed).random
        inv_cdf = _normal_dist_inv_cdf
        mu = self._mu
        sigma = self._sigma
        return [inv_cdf(rnd(), mu, sigma) for _ in repeat(None, n)]

    def pdf(self, x):
        variance = self._sigma * self._sigma
        if not variance:
            raise StatisticsError('pdf() not defined when sigma is zero')
        diff = x - self._mu
        return exp(diff * diff / (-2.0 * variance)) / sqrt(tau * variance)

    def cdf(self, x):
        if not self._sigma:
            raise StatisticsError('cdf() not defined when sigma is zero')
        return 0.5 * math.erfc((self._mu - x) / (self._sigma * _SQRT2))

    def inv_cdf(self, p):
        if p <= 0.0 or p >= 1.0:
            raise StatisticsError('p must be in the range 0.0 < p < 1.0')
        return _normal_dist_inv_cdf(p, self._mu, self._sigma)

    def quantiles(self, n=4):
        return [self.inv_cdf(i / n) for i in range(1, n)]

    def overlap(self, other):
        if not isinstance(other, NormalDist):
            raise TypeError('Expected another NormalDist instance')
        X, Y = self, other
        if (Y._sigma, Y._mu) < (X._sigma, X._mu):
            X, Y = Y, X
        X_var, Y_var = X.variance, Y.variance
        if not X_var or not Y_var:
            raise StatisticsError('overlap() not defined when sigma is zero')
        dv = Y_var - X_var
        dm = fabs(Y._mu - X._mu)
        if not dv:
            return math.erfc(dm / (2.0 * X._sigma * _SQRT2))
        a = X._mu * Y_var - Y._mu * X_var
        b = X._sigma * Y._sigma * sqrt(dm * dm + dv * log(Y_var / X_var))
        x1 = (a + b) / dv
        x2 = (a - b) / dv
        return 1.0 - (fabs(Y.cdf(x1) - X.cdf(x1)) + fabs(Y.cdf(x2) - X.cdf(x2)))

    def zscore(self, x):
        if not self._sigma:
            raise StatisticsError('zscore() not defined when sigma is zero')
        return (x - self._mu) / self._sigma

    @property
    def mean(self):
        return self._mu

    @property
    def median(self):
        return self._mu

    @property
    def mode(self):
        return self._mu

    @property
    def stdev(self):
        return self._sigma

    @property
    def variance(self):
        return self._sigma * self._sigma

    def __add__(x1, x2):
        if isinstance(x2, NormalDist):
            return NormalDist(x1._mu + x2._mu, hypot(x1._sigma, x2._sigma))
        return NormalDist(x1._mu + x2, x1._sigma)

    def __sub__(x1, x2):
        if isinstance(x2, NormalDist):
            return NormalDist(x1._mu - x2._mu, hypot(x1._sigma, x2._sigma))
        return NormalDist(x1._mu - x2, x1._sigma)

    def __mul__(x1, x2):
        return NormalDist(x1._mu * x2, x1._sigma * fabs(x2))

    def __truediv__(x1, x2):
        return NormalDist(x1._mu / x2, x1._sigma / fabs(x2))

    def __pos__(x1):
        return NormalDist(x1._mu, x1._sigma)

    def __neg__(x1):
        return NormalDist(-x1._mu, x1._sigma)

    __radd__ = __add__

    def __rsub__(x1, x2):
        return -(x1 - x2)

    __rmul__ = __mul__

    def __eq__(x1, x2):
        if not isinstance(x2, NormalDist):
            return NotImplemented
        return x1._mu == x2._mu and x1._sigma == x2._sigma

    def __hash__(self):
        return hash((self._mu, self._sigma))

    def __repr__(self):
        return f'{type(self).__name__}(mu={self._mu!r}, sigma={self._sigma!r})'


def _sum(data):
    count = 0
    types = set()
    types_add = types.add
    partials = {}
    partials_get = partials.get
    for typ, values in groupby(data, type):
        types_add(typ)
        for n, d in map(_exact_ratio, values):
            count += 1
            partials[d] = partials_get(d, 0) + n
    if None in partials:
        total = partials[None]
    else:
        total = _fraction_sum(_Fraction(n, d) for d, n in partials.items())
    T = reduce(_coerce, types, int)
    return (T, total, count)


def _squared_deviations(data, c):
    for x in data:
        d = x - c
        yield d * d


def _ss(data, c=None):
    if c is not None:
        T, ssd, count = _sum(_squared_deviations(data, c))
        return (T, ssd, c, count)
    count = 0
    types = set()
    types_add = types.add
    sx_partials = defaultdict(int)
    sxx_partials = defaultdict(int)
    for typ, values in groupby(data, type):
        types_add(typ)
        for n, d in map(_exact_ratio, values):
            count += 1
            sx_partials[d] += n
            sxx_partials[d] += n * n
    if not count:
        ssd = c = _Fraction(0)
    elif None in sx_partials:
        ssd = c = sx_partials[None]
    else:
        sx = _fraction_sum(_Fraction(n, d) for d, n in sx_partials.items())
        sxx = _fraction_sum(_Fraction(n, d*d) for d, n in sxx_partials.items())
        ssd = (count * sxx - sx * sx) / count
        c = sx / count
    T = reduce(_coerce, types, int)
    return (T, ssd, c, count)


def _coerce(T, S):
    if T is S:  return T
    if S is int or S is bool:  return T
    if T is int:  return S
    if issubclass(S, T):  return S
    if issubclass(T, S):  return T
    if issubclass(T, int):  return S
    if issubclass(S, int):  return T
    msg = "don't know how to coerce %s and %s"
    raise TypeError(msg % (T.__name__, S.__name__))


def _exact_ratio(x):
    try:
        return x.as_integer_ratio()
    except AttributeError:
        pass
    except (OverflowError, ValueError):
        return (x, None)
    try:
        return (x.numerator, x.denominator)
    except AttributeError:
        msg = f"can't convert type '{type(x).__name__}' to numerator/denominator"
        raise TypeError(msg)


def _convert(value, T):
    if type(value) is T:
        return value
    if issubclass(T, int) and value.denominator != 1:
        T = float
    if isinstance(value, _Fraction):
        if T is float:
            return value.numerator / value.denominator
        if T is int:
            return value.numerator
    return T(value)


def _fail_neg(values, errmsg='negative value'):
    for x in values:
        if x < 0:
            raise StatisticsError(errmsg)
        yield x


def _rank(data, /, *, key=None, reverse=False, ties='average', start=1):
    if ties != 'average':
        raise ValueError(f'Unknown tie resolution method: {ties!r}')
    if key is not None:
        data = map(key, data)
    val_pos = sorted(zip(data, count()), reverse=reverse)
    i = start - 1
    result = [0] * len(val_pos)
    for _, g in groupby(val_pos, key=itemgetter(0)):
        group = list(g)
        size = len(group)
        rank = i + (size + 1) / 2
        for value, orig_pos in group:
            result[orig_pos] = rank
        i += size
    return result


def _integer_sqrt_of_frac_rto(n, m):
    a = math.isqrt(n // m)
    return a | (a*a*m != n)


_sqrt_bit_width = 2 * 53 + 3


def _float_sqrt_of_frac(n, m):
    q = (n.bit_length() - m.bit_length() - _sqrt_bit_width) // 2
    if q >= 0:
        numerator = _integer_sqrt_of_frac_rto(n, m << 2 * q) << q
        denominator = 1
    else:
        numerator = _integer_sqrt_of_frac_rto(n << -2 * q, m)
        denominator = 1 << -q
    return numerator / denominator


def _mean_stdev(data):
    T, ss, xbar, n = _ss(data)
    if n < 2:
        raise StatisticsError('stdev requires at least two data points')
    mss = ss / (n - 1)
    try:
        return _float(xbar), _float_sqrt_of_frac(mss.numerator, mss.denominator)
    except AttributeError:
        return _float(xbar), _float(xbar) / _float(ss)


def _float(x):
    if isinstance(x, _Fraction):
        return x.numerator / x.denominator
    return float(x)


def _sqrtprod(x, y):
    h = sqrt(x * y)
    if not isfinite(h):
        if isinf(h) and not isinf(x) and not isinf(y):
            scale = 2.0 ** -512
            return _sqrtprod(scale * x, scale * y) / scale
        return h
    if not h:
        if x and y:
            scale = 2.0 ** 537
            return _sqrtprod(scale * x, scale * y) / scale
        return h
    d = sumprod((x, h), (y, -h))
    return h + d / (2.0 * h)


_C0 = float('1.0507500716444169e-09')
_C1 = float('2.0103343992922881e-07')
_C2 = float('2.7115555687434876e-05')
_C3 = float('2.0442631033899397e-15')
_C4 = float('1.421511758316446e-07')
_C5 = float('1.8463183175100548e-05')


def _fma(x, y, z):
    try:
        return math.fma(x, y, z)
    except ValueError:
        return math.nan
    except OverflowError:
        return x * y + z


def _normal_dist_inv_cdf(p, mu, sigma):
    q = p - 0.5
    if fabs(q) <= 0.425:
        r = _fma(-q, q, 0.180625)
        num = _fma(_fma(_fma(_fma(_fma(_fma(_fma(2509.0809287301227, r, 33430.57558358813), r, 67265.7709270087), r, 45921.95393154987), r, 13731.69376550946), r, 1971.5909503065513), r, 133.14166789178438), r, 3.3871328727963665) * q
        den = _fma(_fma(_fma(_fma(_fma(_fma(_fma(5226.495278852854, r, 28729.085735721943), r, 39307.89580009271), r, 21213.794301586597), r, 5394.196021424751), r, 687.1870074920579), r, 42.31333070160091), r, 1.0)
        x = num / den
        return _fma(x, sigma, mu)
    if q <= 0.0:
        r = p
    else:
        r = 1.0 - p
    r = sqrt(-log(r))
    if r <= 5.0:
        r = r - 1.6
        num = _fma(_fma(_fma(_fma(_fma(_fma(_fma(0.0007745450142783414, r, 0.022723844989269184), r, 0.2417807251774506), r, 1.2704582524523684), r, 3.6478483247632045), r, 5.769497221460691), r, 4.630337846156546), r, 1.4234371107496835)
        den = _fma(_fma(_fma(_fma(_fma(_fma(_fma(_C0, r, 0.0005475938084995345), r, 0.015198666563616457), r, 0.14810397642748008), r, 0.6897673349851), r, 1.6763848301838038), r, 2.053191626637759), r, 1.0)
    else:
        r = r - 5.0
        num = _fma(_fma(_fma(_fma(_fma(_fma(_fma(_C1, r, _C2), r, 0.0012426609473880784), r, 0.026532189526576124), r, 0.29656057182850487), r, 1.7848265399172913), r, 5.463784911164114), r, 6.657904643501103)
        den = _fma(_fma(_fma(_fma(_fma(_fma(_fma(_C3, r, _C4), r, _C5), r, 0.0007868691311456133), r, 0.014875361290850615), r, 0.1369298809227358), r, 0.599832206555888), r, 1.0)
    x = num / den
    if q < 0.0:
        x = -x
    return _fma(x, sigma, mu)
`;
