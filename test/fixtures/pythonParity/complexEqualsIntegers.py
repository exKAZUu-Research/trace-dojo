nan = float('nan')
got = [complex(9007199254740992, 0) == 9007199254740993, complex(1, 0) == 10 ** 400, complex(1, 0) == 1, complex(1, 0) == True, complex(1.5, 0) == 1.5, complex(1, 1) == 1, 1 == complex(1, 0), 10 ** 400 != complex(1, 0), complex(nan, 0) == nan, complex(2, 0) == 2.0, complex(0, 0) == False, complex(-0.0, 0) == 0]
if got != [False, False, True, True, True, False, True, True, False, True, True, True]:
    raise AssertionError(got)
