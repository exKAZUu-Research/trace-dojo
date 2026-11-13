import math
import statistics
from statistics import *

ints = [2, 7, 1, 8, 2, 8, 1, 8, 2, 8]
floats = [2.5, 3.25, 5.5, 11.25, 11.75, 0.1, 0.2, 0.3]
mixed = [1, 2.5, True, 70368744177664, 0.1, -3]
huge = [10 ** 30, 10 ** 30 + 1, 10 ** 30 + 5]
tiny = [0.000001, 0.000002, 0.0000035]
xs = [1, 2, 3, 4, 5, 6.5, 7.25]
ys = [2.1, 3.9, 6.2, 7.8, 10.1, 13.4, 14.2]
# The results checked here come from exact arithmetic and square roots only: those of math.exp, math.log and the
# trigonometric functions depend on the platform's C library.
inf = float('inf')
nan = float('nan')


def samples(kernel, cumulative):
    estimate = kde([1.5, 2, 2.5, 4, 7], 1.25, kernel, cumulative=cumulative)
    return [estimate(x) for x in [0.5, 2.25, 3.9, 8]]


def draws(kernel):
    rand = kde_random([1.5, 2, 2.5, 4, 7], 1.25, kernel, seed=8675309)
    return [rand() for _ in range(3)]


def outcome(thunk):
    try:
        return repr(thunk())
    except Exception as error:
        return type(error).__name__ + ': ' + str(error)


def check(thunk, expected):
    actual = outcome(thunk)
    if actual != expected:
        raise AssertionError('expected ' + expected + ' but got ' + actual)


check(lambda: [mean(data) for data in (ints, floats, mixed, huge, tiny)], '[4.7, 4.35625, 11728124029610.934, 1000000000000000000000000000002, 2.1666666666666665e-06]')
check(lambda: [fmean(data) for data in (ints, floats, mixed, huge, tiny)], '[4.7, 4.35625, 11728124029610.932, 1.0000000000000002e+30, 2.1666666666666665e-06]')
check(lambda: [harmonic_mean(data) for data in (ints, floats, huge, tiny)], '[2.413793103448276, 0.4124383339438644, 9.999999999999999e+29, 1.68e-06]')
check(lambda: [median(data) for data in (ints, floats, mixed, huge, tiny)], '[4.5, 2.875, 1.0, 1000000000000000000000000000001, 2e-06]')
check(lambda: [median_low(data) for data in (ints, floats, mixed)], '[2, 2.5, 1]')
check(lambda: [median_high(data) for data in (ints, floats, mixed)], '[7, 3.25, True]')
check(lambda: [median_grouped(data) for data in (ints, floats, mixed)], '[6.5, 2.75, 1.0]')
check(lambda: [median_grouped(ints, interval) for interval in (2, 0.5, 10)], '[6.0, 6.75, 2.0]')
check(lambda: [mode(data) for data in (ints, floats, 'aabbbc', [True, 1, 1.0, 2])], "[8, 2.5, 'b', True]")
check(lambda: [multimode(data) for data in (ints, floats, 'aabbcc', [])], "[[8], [2.5, 3.25, 5.5, 11.25, 11.75, 0.1, 0.2, 0.3], ['a', 'b', 'c'], []]")
check(lambda: [variance(data) for data in (ints, floats, mixed, huge, tiny)], '[10.9, 22.85888392857143, 8.252933595235794e+26, 7, 1.5833333333333333e-12]')
check(lambda: [pvariance(data) for data in (ints, floats, mixed, huge, tiny)], '[9.81, 20.0015234375, 6.877444662696494e+26, 4.666666666666667, 1.0555555555555555e-12]')
check(lambda: [stdev(data) for data in (ints, floats, mixed, huge, tiny)], '[3.3015148038438356, 4.78109651947871, 28727919512620.113, 2.6457513110645907, 1.2583057392117915e-06]')
check(lambda: [pstdev(data) for data in (ints, floats, mixed, huge, tiny)], '[3.132091952673165, 4.472306277246673, 26224882578758.086, 2.160246899469287, 1.0274023338281627e-06]')
check(lambda: [variance(ints, 4), pvariance(floats, 4.5), stdev(ints, 4.7), pstdev(floats, 4), variance(mixed, 0.1)], '[11.444444444444445, 20.0221875, 3.3015148038438356, 4.48647272364382, 9.903520314283014e+26]')
check(lambda: [quantiles(data) for data in (ints, floats, mixed)], '[[1.75, 4.5, 8.0], [0.22500000000000003, 2.875, 9.8125], [-0.675, 1.0, 17592186044417.875]]')
check(lambda: [quantiles(data, n=10) for data in (ints, floats)], '[[1.0, 1.2, 2.0, 2.0, 4.5, 7.6, 8.0, 8.0, 8.0], [0.09000000000000001, 0.18, 0.27, 1.6199999999999999, 2.875, 4.15, 7.225, 11.35, 11.8]]')
check(lambda: [quantiles(data, method='inclusive') for data in (ints, floats, mixed)], '[[2.0, 4.5, 8.0], [0.27499999999999997, 2.875, 6.9375], [0.325, 1.0, 2.125]]')
check(lambda: [quantiles(floats, n=n, method='inclusive') for n in (1, 2, 3, 7)], '[[], [2.875], [1.0333333333333334, 4.75], [0.2, 0.3, 2.5, 3.25, 5.5, 11.25]]')
check(lambda: (quantiles([1.5], n=3), quantiles(range(1, 100), n=4), quantiles([1, 2], n=5)), '([1.5, 1.5], [25.0, 50.0, 75.0], [0.6, 1.2, 1.8, 2.4])')
check(lambda: (covariance(xs, ys), covariance(ys, xs), covariance(xs, xs), covariance(huge, [1, 2, 4])), '(10.544642857142856, 10.544642857142856, 5.288690476190476, 0.03125)')
check(lambda: (correlation(xs, ys), correlation(xs, ys, method='ranked'), correlation(ints[:7], ys), correlation(ints[:7], ys, method='ranked')), '(0.9986034605891062, 1.0, 0.028893532360350648, -0.036711154910717615)')
check(lambda: linear_regression(xs, ys), 'LinearRegression(slope=1.9938097917839053, intercept=0.05399549803039072)')
check(lambda: linear_regression(xs, ys, proportional=True), 'LinearRegression(slope=2.0041718815185647, intercept=0.0)')
check(lambda: (linear_regression(xs, ys).slope, tuple(linear_regression([1, 2, 3], [2, 4, 7])), statistics.LinearRegression), "(1.9938097917839053, (2.5, -0.666666666666667), <class 'statistics.LinearRegression'>)")
check(lambda: (fmean([85, 92, 83, 91], [0.2, 0.2, 0.3, 0.3]), fmean(iter(floats)), harmonic_mean([40, 60], weights=[5, 30]), harmonic_mean([1, 0, 2])), '(87.6, 4.35625, 56.0, 0)')
check(lambda: (mean(range(10)), mean([True, True, False]), mean({1: 2, 4: 5}), mean(iter([1, 2, 4])), mean((0.1, 0.2, 0.3))), '(4.5, 0.6666666666666666, 2.5, 2.3333333333333335, 0.2)')
check(lambda: (stdev([1.5, 2.5, 2.5, 2.75, 3.25, 4.75]), pstdev([2 ** 70, 2 ** 70 + 2]), stdev([10 ** 400, 0]), mean([10 ** 400, 1])), 'OverflowError: integer division result too large for a float')
check(lambda: (mean([inf, 1]), fmean([inf, 1]), math.isnan(variance([nan, 1.0])), geometric_mean([0, 2]), math.isnan(geometric_mean([inf, 0]))), '(inf, inf, True, 0.0, True)')
check(lambda: (math.sumprod([1, 2, 3], [4, 5, 6]), math.sumprod([0.1, 0.2, 0.3], [0.3, 0.2, 0.1]), math.sumprod([1, 2.5, True], [0.1, 3, 0.7])), '(32, 0.1, 8.3)')
check(lambda: (math.sumprod([10 ** 20, 1], [10 ** 20, 2]), math.sumprod([9007199254740993, 0.1], [1.0, 3]), math.sumprod([], [])), '(10000000000000000000000000000000000000002, 9007199254740992.0, 0)')
check(lambda: (math.sumprod([123456789.123, -123456789.123, 0.001], [987654321.5, 987654321.5, 1]), math.sumprod([inf, 1.0], [1.0, 2.0])), '(0.001, inf)')
check(lambda: math.sumprod([1, 2], [3]), 'ValueError: Inputs are not the same length')
check(lambda: math.sumprod([1], ['a']), "TypeError: unsupported operand type(s) for +: 'int' and 'str'")
check(lambda: (NormalDist(), NormalDist(1, 2), NormalDist(mu=3.5, sigma=0.25), NormalDist.from_samples([2.5, 3.1, 2.1, 2.4, 2.7, 3.5])), '(NormalDist(mu=0.0, sigma=1.0), NormalDist(mu=1.0, sigma=2.0), NormalDist(mu=3.5, sigma=0.25), NormalDist(mu=2.716666666666667, sigma=0.5076087732365021))')
check(lambda: (NormalDist(100, 15).zscore(130), NormalDist(100, 15).inv_cdf(0.5), NormalDist(100, 15).inv_cdf(0.3), NormalDist().inv_cdf(0.9)), '(2.0, 100.0, 92.1339923093794, 1.2815515655446006)')
check(lambda: (NormalDist(100, 15).quantiles(), NormalDist().quantiles(n=10), NormalDist(2.5, 0.75).inv_cdf(0.08)), '([89.88265374705877, 100.0, 110.11734625294123], [-1.2815515655446006, -0.8416212335729142, -0.5244005127080408, -0.2533471031357998, 0.0, 0.2533471031357998, 0.5244005127080407, 0.8416212335729144, 1.2815515655446006], 1.4461963297677758)')
check(lambda: NormalDist(0, 1).samples(0, seed=1), '[]')
check(lambda: (NormalDist(1, 2).mean, NormalDist(1, 2).median, NormalDist(1, 2).mode, NormalDist(1, 2).stdev, NormalDist(1, 2).variance), '(1.0, 1.0, 1.0, 2.0, 4.0)')
check(lambda: (NormalDist(1, 2) + NormalDist(3, 4), NormalDist(1, 2) - NormalDist(3, 4), NormalDist(1, 2) * 3, NormalDist(1, 2) / -4, NormalDist(1, 2) + 5), '(NormalDist(mu=4.0, sigma=4.47213595499958), NormalDist(mu=-2.0, sigma=4.47213595499958), NormalDist(mu=3.0, sigma=6.0), NormalDist(mu=-0.25, sigma=0.5), NormalDist(mu=6.0, sigma=2.0))')
check(lambda: (3 + NormalDist(), 2 * NormalDist(1, 1), 1.5 - NormalDist(1, 3), -NormalDist(1, 2), +NormalDist(1, 2)), '(NormalDist(mu=3.0, sigma=1.0), NormalDist(mu=2.0, sigma=2.0), NormalDist(mu=0.5, sigma=3.0), NormalDist(mu=-1.0, sigma=2.0), NormalDist(mu=1.0, sigma=2.0))')
check(lambda: (NormalDist(1, 2) == NormalDist(1.0, 2.0), NormalDist(1, 2) == 3, hash(NormalDist(1, 2)) == hash(NormalDist(1.0, 2.0)), {NormalDist(1, 2): 1}[NormalDist(1.0, 2.0)]), '(True, False, True, 1)')
check(lambda: [samples(kernel, False) for kernel in ('rectangular', 'triangular', 'parabolic', 'quartic', 'triweight')], '[[0.08, 0.24, 0.08, 0.08], [0.031999999999999994, 0.32, 0.1472, 0.031999999999999994], [0.04319999999999999, 0.3072, 0.11923200000000002, 0.04319999999999999], [0.019439999999999985, 0.33792, 0.148086144, 0.019439999999999985], [0.008164799999999993, 0.3555327999999999, 0.17166145812480005, 0.008164799999999993]]')
check(lambda: [samples(kernel, False) for kernel in ('uniform', 'epanechnikov', 'biweight')], '[[0.08, 0.24, 0.08, 0.08], [0.04319999999999999, 0.3072, 0.11923200000000002, 0.04319999999999999], [0.019439999999999985, 0.33792, 0.148086144, 0.019439999999999985]]')
check(lambda: [samples(kernel, True) for kernel in ('rectangular', 'triangular', 'parabolic', 'quartic', 'triweight')], '[[0.019999999999999997, 0.36, 0.692, 0.9800000000000001], [0.0040000000000000036, 0.384, 0.68464, 0.9960000000000001], [0.005599999999999999, 0.3792, 0.6880256, 0.9944], [0.0017120000000000039, 0.388416, 0.6850638771199999, 0.998288], [0.0005456000000000084, 0.3933312, 0.68261157057536, 0.9994544]]')
check(lambda: [draws(kernel) for kernel in ('rectangular', 'uniform', 'triangular')], '[[3.2853028981061128, 7.901791730848877, 3.4037142366430557], [3.2853028981061128, 7.901791730848877, 3.4037142366430557], [3.568002825565194, 7.590257371061333, 3.0920811568314974]]')
check(lambda: (kde([1, 2], 1).__doc__, kde([1, 2], 1, 'cosine', cumulative=True).__doc__, kde_random([1.0], 1.5, seed=3).__doc__), '("PDF estimate with h=1 and kernel=\'normal\'", "CDF estimate with h=1 and kernel=\'cosine\'", "Random KDE selection with h=1.5 and kernel=\'normal\'")')
check(lambda: mean([]), 'StatisticsError: mean requires at least one data point')
check(lambda: mean(), "TypeError: mean() missing 1 required positional argument: 'data'")
check(lambda: mean('abc'), "TypeError: can't convert type 'str' to numerator/denominator")
check(lambda: mean([1, 'a']), "TypeError: can't convert type 'str' to numerator/denominator")
check(lambda: mean(3), "TypeError: 'int' object is not iterable")
check(lambda: fmean([]), 'StatisticsError: fmean requires at least one data point')
check(lambda: fmean([1, 2], [1]), 'StatisticsError: data and weights must be the same length')
check(lambda: fmean([1, 2], [0, 0]), 'StatisticsError: sum of weights must be non-zero')
check(lambda: geometric_mean([]), 'StatisticsError: Must have a non-empty dataset')
check(lambda: geometric_mean([1, -2]), "StatisticsError: ('No negative inputs allowed', -2)")
check(lambda: geometric_mean(['a']), "TypeError: '>' not supported between instances of 'str' and 'float'")
check(lambda: harmonic_mean([]), 'StatisticsError: harmonic_mean requires at least one data point')
check(lambda: harmonic_mean([1, -2]), 'StatisticsError: harmonic mean does not support negative values')
check(lambda: harmonic_mean(['a']), 'TypeError: unsupported type')
check(lambda: harmonic_mean([1, 2], [1]), 'StatisticsError: Number of weights does not match data size')
check(lambda: harmonic_mean([1, 2], [0, 0]), 'StatisticsError: Weighted sum must be positive')
check(lambda: median([]), 'StatisticsError: no median for empty data')
check(lambda: median_low([]), 'StatisticsError: no median for empty data')
check(lambda: median_high([]), 'StatisticsError: no median for empty data')
check(lambda: median_grouped([]), 'StatisticsError: no median for empty data')
check(lambda: median_grouped(['a']), 'TypeError: Value cannot be converted to a float')
check(lambda: median([1, 'a']), "TypeError: '<' not supported between instances of 'str' and 'int'")
check(lambda: mode([]), 'StatisticsError: no mode for empty data')
check(lambda: variance([1]), 'StatisticsError: variance requires at least two data points')
check(lambda: variance([], 2), 'StatisticsError: variance requires at least two data points')
check(lambda: pvariance([]), 'StatisticsError: pvariance requires at least one data point')
check(lambda: stdev([1]), 'StatisticsError: stdev requires at least two data points')
check(lambda: stdev([1, 2], 3, 4), 'TypeError: stdev() takes from 1 to 2 positional arguments but 3 were given')
check(lambda: pstdev([]), 'StatisticsError: pstdev requires at least one data point')
check(lambda: stdev([inf, 1]), 'ValueError: inf or nan encountered in data')
check(lambda: quantiles([]), 'StatisticsError: must have at least one data point')
check(lambda: quantiles([1, 2], n=0), 'StatisticsError: n must be at least 1')
check(lambda: quantiles([1, 2], method='x'), "ValueError: Unknown method: 'x'")
check(lambda: quantiles([1, 2], 3), 'TypeError: quantiles() takes 1 positional argument but 2 were given')
check(lambda: covariance([1, 2], [1]), 'StatisticsError: covariance requires that both inputs have same number of data points')
check(lambda: covariance([1], [1]), 'StatisticsError: covariance requires at least two data points')
check(lambda: correlation([1, 2, 3], [1, 1, 1]), 'StatisticsError: at least one of the inputs is constant')
check(lambda: correlation([1, 2, 3], [3, 2, 1], method='x'), "ValueError: Unknown method: 'x'")
check(lambda: correlation([1], [1]), 'StatisticsError: correlation requires at least two data points')
check(lambda: linear_regression([1, 1], [1, 2]), 'StatisticsError: x is constant')
check(lambda: linear_regression([1, 2], [1]), 'StatisticsError: linear regression requires that both inputs have same number of data points')
check(lambda: NormalDist(0, -1), 'StatisticsError: sigma must be non-negative')
check(lambda: NormalDist().overlap(3), 'TypeError: Expected another NormalDist instance')
check(lambda: NormalDist(1, 0).pdf(1), 'StatisticsError: pdf() not defined when sigma is zero')
check(lambda: NormalDist(1, 0).zscore(1), 'StatisticsError: zscore() not defined when sigma is zero')
check(lambda: NormalDist().inv_cdf(0), 'StatisticsError: p must be in the range 0.0 < p < 1.0')
check(lambda: NormalDist().inv_cdf(1.5), 'StatisticsError: p must be in the range 0.0 < p < 1.0')
check(lambda: NormalDist.from_samples([1]), 'StatisticsError: stdev requires at least two data points')
check(lambda: kde([], 1), 'StatisticsError: Empty data sequence')
check(lambda: kde(['a'], 1), 'TypeError: Data sequence must contain ints or floats')
check(lambda: kde([1], 0), 'StatisticsError: Bandwidth h must be positive, not h=0')
check(lambda: kde([1], 1, 'zz'), "StatisticsError: Unknown kernel name: 'zz'")
check(lambda: kde_random([1], -1.5), 'StatisticsError: Bandwidth h must be positive, not h=-1.5')
check(lambda: (StatisticsError, StatisticsError.__mro__, StatisticsError('x').args, isinstance(StatisticsError(), ValueError)), "(<class 'statistics.StatisticsError'>, (<class 'statistics.StatisticsError'>, <class 'ValueError'>, <class 'Exception'>, <class 'BaseException'>, <class 'object'>), ('x',), True)")
check(lambda: (statistics.__all__, mean.__name__, NormalDist), "(['NormalDist', 'StatisticsError', 'correlation', 'covariance', 'fmean', 'geometric_mean', 'harmonic_mean', 'kde', 'kde_random', 'linear_regression', 'mean', 'median', 'median_grouped', 'median_high', 'median_low', 'mode', 'multimode', 'pstdev', 'pvariance', 'quantiles', 'stdev', 'variance'], 'mean', <class 'statistics.NormalDist'>)")
