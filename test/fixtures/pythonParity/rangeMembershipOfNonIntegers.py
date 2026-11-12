class AlwaysEqual:
    def __eq__(self, other):
        return True


results = [
    2.0 in range(5),
    2.5 in range(5),
    5.0 in range(5),
    "a" in range(3),
    None in range(3),
    4.0 in range(0, 10, 2),
    AlwaysEqual() in range(2),
    AlwaysEqual() in range(0),
    True in range(3),
    range(5).count(2.0),
    range(5).count(2.5),
    range(5).count("x"),
    range(5).count(AlwaysEqual()),
    range(3).count(True),
    range(2, 9).index(4.0),
    range(5).index(AlwaysEqual()),
    range(0, 10, 2).index(6),
]
expected = [True, False, False, False, False, True, True, False, True, 1, 0, 0, 5, 1, 2, 0, 3]
if results != expected:
    raise AssertionError(results)

messages = []
for missing in (9, 2.5, "a", None):
    try:
        range(5).index(missing)
        raise AssertionError(missing)
    except ValueError as error:
        messages.append(str(error))
if messages != ["range.index(x): x not in range"] + ["sequence.index(x): x not in sequence"] * 3:
    raise AssertionError(messages)
