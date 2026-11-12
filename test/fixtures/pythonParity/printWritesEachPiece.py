class Log:
    def __init__(self):
        self.calls = []
    def write(self, text):
        self.calls.append(text)
log = Log()
print(1, 'a', [2], sep='-', end='!\n', file=log)
print(file=log)
print('x', file=log)
if log.calls != ['1', '-', 'a', '-', '[2]', '!\n', '\n', 'x', '\n']:
    raise AssertionError(log.calls)
if [pow(3, -1, 7), pow(10, -2, 7), pow(2, 100, 1000)] != [5, 4, 376]:
    raise AssertionError('pow')
