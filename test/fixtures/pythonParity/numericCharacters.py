samples = ['京', '壹', '佰', '柒', '〇', '一', '½', '²', '①', '٣', '５', 'Ⅻ', '𝟙', 'a', '_', '\U0001F100']
got = [[c.isdecimal(), c.isdigit(), c.isnumeric()] for c in samples]
expected = [[False, False, True], [False, False, True], [False, False, True], [False, False, True], [False, False, True], [False, False, True], [False, False, True], [False, True, True], [False, True, True], [True, True, True], [True, True, True], [False, False, True], [True, True, True], [False, False, False], [False, False, False], [False, True, True]]
if got != expected or not '京一二'.isnumeric() or '京a'.isnumeric():
    raise AssertionError(got)
