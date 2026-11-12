if format(1234567, "021,") != "0,000,000,001,234,567" or len(format(1.5, "0100001,.3f")) != 100001 or len("%.100000d" % 1) != 100000:
    raise AssertionError("padding")
for spec in ("99999999999999999999", ".99999999999999999999f"):
    try:
        format(1.0, spec)
        raise AssertionError(spec)
    except ValueError as error:
        if str(error) != "Too many decimal digits in format string":
            raise
