samples = ['京', '壹', '佰', '柒', '〇', '一', '½', '²', '①', '٣', '５', 'Ⅻ', '𝟙', 'a', '_', '\U0001F100']
got = [[c.isdecimal(), c.isdigit(), c.isnumeric()] for c in samples]
expected = [[False, False, True], [False, False, True], [False, False, True], [False, False, True], [False, False, True], [False, False, True], [False, False, True], [False, True, True], [False, True, True], [True, True, True], [True, True, True], [False, False, True], [True, True, True], [False, False, False], [False, False, False], [False, True, True]]
if got != expected or not '京一二'.isnumeric() or '京a'.isnumeric():
    raise AssertionError(got)
# Digits of adjacent blocks, such as the mathematical ones, count from each block's zero in every conversion.
import string
check = [complex('𝟜+𝟝j'), '{𝟘}'.format('ok'), '{0[𝟙]}'.format(['a', 'b']), string.Formatter().format('{𝟘}', 'ok'), int('𝟡𝟠𝟭𝟮'), float('𝟙.𝟝'), '{:𝟝}|'.format('a'), int('𝟶𝟿𝟬')]
if check != [4 + 5j, 'ok', 'b', 'ok', 9812, 1.5, 'a    |', 90]:
    raise AssertionError(check)
