class E:
    def name(self):
        return __class__.__name__
    def nested(self):
        def inner():
            return __class__.__name__
        return inner()
    def lam(self):
        return (lambda: __class__)().__name__
    def comp(self):
        return [__class__.__name__ for _ in range(1)][0]
class F(E):
    pass
got = [E().name(), F().name(), E().nested(), E().lam(), F().comp()]
try:
    class G:
        x = __class__
except NameError as e:
    got.append(str(e))
got.append([round(1, -100000000), round(-7, -1), round(15, -1), round(25, -1), round(149, -2), round(150, -2), round(250, -2), round(-250, -2), round(10 ** 30 + 5, -1), round(99, -3), round(500, -3), round(501, -3)])
if got != ['E', 'E', 'E', 'E', 'E', "name '__class__' is not defined", [0, -10, 20, 20, 100, 200, 200, -200, 10 ** 30, 0, 0, 1000]]:
    raise AssertionError(got)
