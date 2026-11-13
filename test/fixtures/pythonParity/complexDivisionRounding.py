# Complex division and powers round as CPython's _Py_c_quot and _Py_c_pow do, with each x*y±z fused as the compiler
# of the reference CPython contracts it, and recover the infinities and zeros that compute as nan+nanj.
inf = float('inf')
got = [repr((3+4j) / (4-5j)), repr((1-3j) / (2-3j)), repr(2.5 / (3-7j)), repr((1.5+2j) ** (0.5-1.5j)), repr((2-1j) ** -3), repr(complex(inf, 1) / (1+1j)), repr((1+1j) / complex(inf, 0)), repr((1+2j) / complex(inf, inf))]
expected = ['(-0.1951219512195122+0.7560975609756099j)', '(0.8461538461538461-0.23076923076923075j)', '(0.1293103448275862+0.3017241379310345j)', '(3.8957980682163313-5.0195984610960265j)', '(0.016+0.08800000000000001j)', '(inf-infj)', '0j', '0j']
if got != expected:
    raise AssertionError(got)
