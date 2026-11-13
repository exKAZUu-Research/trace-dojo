got = [complex('１２+３４j'), complex('1_000+2_000j'), complex(' (1.5e1_0-2_5j) '), complex('-j'), complex('inf+nanj'), complex('.5e-1_0'), complex('3J')]
for bad in ['1__0+2j', '_1+2j', '1_+2j', '1+2j_', '1 + 2j', '1e+_5']:
    try:
        complex(bad)
        got.append('accepted ' + bad)
    except ValueError as e:
        got.append(str(e))
s = repr(got)
if s != "[(12+34j), (1000+2000j), (15000000000-25j), -1j, (inf+nanj), (5e-11+0j), 3j, \"could not convert string to complex: '1__0+2j'\", \"could not convert string to complex: '_1+2j'\", \"could not convert string to complex: '1_+2j'\", \"could not convert string to complex: '1+2j_'\", 'complex() arg is a malformed string', \"could not convert string to complex: '1e+_5'\"]":
    raise AssertionError(s)
