# except and except* check every class a handler names before matching any, and a nested tuple is not a class.
errors = (ValueError, TypeError)
got = []
for types in [(errors, KeyError), (ValueError, 'wrong'), (KeyError, ValueError), ValueError, ()]:
    try:
        try:
            int('x')
        except types:
            got.append('caught')
    except TypeError as error:
        got.append(str(error))
    except ValueError:
        got.append('uncaught')
for types in [(ValueError, 'x'), (ValueError, ExceptionGroup)]:
    try:
        try:
            raise ExceptionGroup('g', [ValueError(1)])
        except* types:
            got.append('star caught')
    except TypeError as error:
        got.append(str(error))
invalid = 'catching classes that do not inherit from BaseException is not allowed'
if got != [invalid, invalid, 'caught', 'caught', 'uncaught', invalid, 'catching ExceptionGroup with except* is not allowed. Use except instead.']:
    raise AssertionError(got)
