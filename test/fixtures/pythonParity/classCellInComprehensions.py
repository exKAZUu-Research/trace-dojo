got = []
for maker in ['list', 'set', 'dict', 'generator']:
    try:
        class C:
            if maker == 'list':
                v = [__class__ for _ in range(1)]
            elif maker == 'set':
                v = {__class__ for _ in range(1)}
            elif maker == 'dict':
                v = {__class__: 1 for _ in range(1)}
            else:
                v = list(__class__ for _ in range(1))
        got.append(maker)
    except NameError as e:
        got.append(str(e))
__class__ = 'global-value'
class D:
    vals = [__class__ for _ in range(2)]
    def m(self):
        return [__class__.__name__ for _ in range(1)]
got.append(D.vals)
got.append(D().m())
expected = ["name '__class__' is not defined", "name '__class__' is not defined", "name '__class__' is not defined", "cannot access free variable '__class__' where it is not associated with a value in enclosing scope", ['global-value', 'global-value'], ['D']]
if got != expected:
    raise AssertionError(got)
