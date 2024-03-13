s.set('a', 1);
if (s.get('a') > 0) {
  s.set('b', 2);
  s.set('a', f(s.get('a'), s.get('b')));
}
s.set('c', s.get('a') * 2);

function f(x, y) {
  try {
    s.enterNewScope();
    s.set('ret', x * y);
    return s.get('ret');
  } finally {
    s.leaveScope();
  }
}
