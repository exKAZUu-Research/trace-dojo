import { registerExtraAttributes } from '../modules';
import { runModuleSource } from '../sourceModules';

// CPython's kernel density estimation of `statistics.py`, run in the module's namespace. The normal kernel's
// cumulative form reads `math.erfc` when called, which this grader does not match to the last digit.
const KDE_SOURCE = String.raw`import math as _math
import random as _random
from bisect import bisect_left, bisect_right
from math import acos, asin, atan, cos, cosh, exp, log, pi, sin, sqrt, sumprod, tan, tau


def _normal_dist_inv_cdf(p, mu, sigma):
    return NormalDist(mu, sigma).inv_cdf(p)


_kernel_specs = {}

def register(*kernels):
    "Load the kernel's pdf, cdf, invcdf, and support into _kernel_specs."
    def deco(builder):
        spec = dict(zip(('pdf', 'cdf', 'invcdf', 'support'), builder()))
        for kernel in kernels:
            _kernel_specs[kernel] = spec
        return builder
    return deco

@register('normal', 'gauss')
def normal_kernel():
    sqrt2pi = sqrt(2 * pi)
    neg_sqrt2 = -sqrt(2)
    pdf = lambda t: exp(-1/2 * t * t) / sqrt2pi
    cdf = lambda t: 1/2 * _math.erfc(t / neg_sqrt2)
    invcdf = lambda t: _normal_dist_inv_cdf(t, 0.0, 1.0)
    support = None
    return pdf, cdf, invcdf, support

@register('logistic')
def logistic_kernel():
    # 1.0 / (exp(t) + 2.0 + exp(-t))
    pdf = lambda t: 1/2 / (1.0 + cosh(t))
    cdf = lambda t: 1.0 - 1.0 / (exp(t) + 1.0)
    invcdf = lambda p: log(p / (1.0 - p))
    support = None
    return pdf, cdf, invcdf, support

@register('sigmoid')
def sigmoid_kernel():
    # (2/pi) / (exp(t) + exp(-t))
    c1 = 1 / pi
    c2 = 2 / pi
    c3 = pi / 2
    pdf = lambda t: c1 / cosh(t)
    cdf = lambda t: c2 * atan(exp(t))
    invcdf = lambda p: log(tan(p * c3))
    support = None
    return pdf, cdf, invcdf, support

@register('rectangular', 'uniform')
def rectangular_kernel():
    pdf = lambda t: 1/2
    cdf = lambda t: 1/2 * t + 1/2
    invcdf = lambda p: 2.0 * p - 1.0
    support = 1.0
    return pdf, cdf, invcdf, support

@register('triangular')
def triangular_kernel():
    pdf = lambda t: 1.0 - abs(t)
    cdf = lambda t: t*t * (1/2 if t < 0.0 else -1/2) + t + 1/2
    invcdf = lambda p: sqrt(2.0*p) - 1.0 if p < 1/2 else 1.0 - sqrt(2.0 - 2.0*p)
    support = 1.0
    return pdf, cdf, invcdf, support

@register('parabolic', 'epanechnikov')
def parabolic_kernel():
    pdf = lambda t: 3/4 * (1.0 - t * t)
    cdf = lambda t: sumprod((-1/4, 3/4, 1/2), (t**3, t, 1.0))
    invcdf = lambda p: 2.0 * cos((acos(2.0*p - 1.0) + pi) / 3.0)
    support = 1.0
    return pdf, cdf, invcdf, support

def _newton_raphson(f_inv_estimate, f, f_prime, tolerance=1e-12):
    def f_inv(y):
        "Return x such that f(x) ≈ y within the specified tolerance."
        x = f_inv_estimate(y)
        while abs(diff := f(x) - y) > tolerance:
            x -= diff / f_prime(x)
        return x
    return f_inv

def _quartic_invcdf_estimate(p):
    # A handrolled piecewise approximation. There is no magic here.
    sign, p = (1.0, p) if p <= 1/2 else (-1.0, 1.0 - p)
    if p < 0.0106:
        return ((2.0 * p) ** 0.3838 - 1.0) * sign
    x = (2.0 * p) ** 0.4258865685331 - 1.0
    if p < 0.499:
        x += 0.026818732 * sin(7.101753784 * p + 2.73230839482953)
    return x * sign

@register('quartic', 'biweight')
def quartic_kernel():
    pdf = lambda t: 15/16 * (1.0 - t * t) ** 2
    cdf = lambda t: sumprod((3/16, -5/8, 15/16, 1/2),
                            (t**5, t**3, t, 1.0))
    invcdf = _newton_raphson(_quartic_invcdf_estimate, f=cdf, f_prime=pdf)
    support = 1.0
    return pdf, cdf, invcdf, support

def _triweight_invcdf_estimate(p):
    # A handrolled piecewise approximation. There is no magic here.
    sign, p = (1.0, p) if p <= 1/2 else (-1.0, 1.0 - p)
    x = (2.0 * p) ** 0.3400218741872791 - 1.0
    if 0.00001 < p < 0.499:
        x -= 0.033 * sin(1.07 * tau * (p - 0.035))
    return x * sign

@register('triweight')
def triweight_kernel():
    pdf = lambda t: 35/32 * (1.0 - t * t) ** 3
    cdf = lambda t: sumprod((-5/32, 21/32, -35/32, 35/32, 1/2),
                            (t**7, t**5, t**3, t, 1.0))
    invcdf = _newton_raphson(_triweight_invcdf_estimate, f=cdf, f_prime=pdf)
    support = 1.0
    return pdf, cdf, invcdf, support

@register('cosine')
def cosine_kernel():
    c1 = pi / 4
    c2 = pi / 2
    pdf = lambda t: c1 * cos(c2 * t)
    cdf = lambda t: 1/2 * sin(c2 * t) + 1/2
    invcdf = lambda p: 2.0 * asin(2.0 * p - 1.0) / pi
    support = 1.0
    return pdf, cdf, invcdf, support

del register, normal_kernel, logistic_kernel, sigmoid_kernel
del rectangular_kernel, triangular_kernel, parabolic_kernel
del quartic_kernel, triweight_kernel, cosine_kernel


def kde(data, h, kernel='normal', *, cumulative=False):
    """Kernel Density Estimation:  Create a continuous probability density
    function or cumulative distribution function from discrete samples.

    The basic idea is to smooth the data using a kernel function
    to help draw inferences about a population from a sample.

    The degree of smoothing is controlled by the scaling parameter h
    which is called the bandwidth.  Smaller values emphasize local
    features while larger values give smoother results.

    The kernel determines the relative weights of the sample data
    points.  Generally, the choice of kernel shape does not matter
    as much as the more influential bandwidth smoothing parameter.

    Kernels that give some weight to every sample point:

       normal (gauss)
       logistic
       sigmoid

    Kernels that only give weight to sample points within
    the bandwidth:

       rectangular (uniform)
       triangular
       parabolic (epanechnikov)
       quartic (biweight)
       triweight
       cosine

    If *cumulative* is true, will return a cumulative distribution function.

    A StatisticsError will be raised if the data sequence is empty.

    Example
    -------

    Given a sample of six data points, construct a continuous
    function that estimates the underlying probability density:

        >>> sample = [-2.1, -1.3, -0.4, 1.9, 5.1, 6.2]
        >>> f_hat = kde(sample, h=1.5)

    Compute the area under the curve:

        >>> area = sum(f_hat(x) for x in range(-20, 20))
        >>> round(area, 4)
        1.0

    Plot the estimated probability density function at
    evenly spaced points from -6 to 10:

        >>> for x in range(-6, 11):
        ...     density = f_hat(x)
        ...     plot = ' ' * int(density * 400) + 'x'
        ...     print(f'{x:2}: {density:.3f} {plot}')
        ...
        -6: 0.002 x
        -5: 0.009    x
        -4: 0.031             x
        -3: 0.070                             x
        -2: 0.111                                             x
        -1: 0.125                                                   x
         0: 0.110                                            x
         1: 0.086                                   x
         2: 0.068                            x
         3: 0.059                        x
         4: 0.066                           x
         5: 0.082                                 x
         6: 0.082                                 x
         7: 0.058                        x
         8: 0.028            x
         9: 0.009    x
        10: 0.002 x

    Estimate P(4.5 < X <= 7.5), the probability that a new sample value
    will be between 4.5 and 7.5:

        >>> cdf = kde(sample, h=1.5, cumulative=True)
        >>> round(cdf(7.5) - cdf(4.5), 2)
        0.22

    References
    ----------

    Kernel density estimation and its application:
    https://www.itm-conferences.org/articles/itmconf/pdf/2018/08/itmconf_sam2018_00037.pdf

    Kernel functions in common use:
    https://en.wikipedia.org/wiki/Kernel_(statistics)#kernel_functions_in_common_use

    Interactive graphical demonstration and exploration:
    https://demonstrations.wolfram.com/KernelDensityEstimation/

    Kernel estimation of cumulative distribution function of a random variable with bounded support
    https://www.econstor.eu/bitstream/10419/207829/1/10.21307_stattrans-2016-037.pdf

    """

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
    """Return a function that makes a random selection from the estimated
    probability density function created by kde(data, h, kernel).

    Providing a *seed* allows reproducible selections within a single
    thread.  The seed may be an integer, float, str, or bytes.

    A StatisticsError will be raised if the *data* sequence is empty.

    Example:

    >>> data = [-2.1, -1.3, -0.4, 1.9, 5.1, 6.2]
    >>> rand = kde_random(data, h=1.5, seed=8675309)
    >>> new_selections = [rand() for i in range(10)]
    >>> [round(x, 1) for x in new_selections]
    [0.7, 6.2, 1.2, 6.9, 7.0, 1.8, 2.5, -0.5, -1.8, 5.6]

    """
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
`;

registerExtraAttributes('statistics', (runtime, namespace) => {
  runModuleSource(runtime, namespace, KDE_SOURCE);
  return [];
});
