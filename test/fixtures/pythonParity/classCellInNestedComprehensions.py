got = []
for kind in ['genexp-in-list', 'lambda-in-list', 'list-in-genexp', 'list-in-list']:
    try:
        class C:
            if kind == 'genexp-in-list':
                v = [list(__class__ for _ in range(1)) for _ in range(1)]
            elif kind == 'lambda-in-list':
                v = [(lambda: __class__)() for _ in range(1)]
            elif kind == 'list-in-genexp':
                v = list([__class__ for _ in range(1)] for _ in range(1))
            else:
                v = [[__class__ for _ in range(1)] for _ in range(1)]
        got.append(kind)
    except NameError as e:
        got.append(str(e))
free = "cannot access free variable '__class__' where it is not associated with a value in enclosing scope"
if got != [free, free, free, "name '__class__' is not defined"]:
    raise AssertionError(got)
