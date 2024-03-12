s.set('a', 1);
if (s.get('a') > 0) {
  // 2
  s.set('b', 2); // 3
  s.set('a', f(s.get('a'), s.get('b'))); // 4
}
let c = s.get('a') * 2; // 5

function f(x, y) {
  // 6
  s = s.enterNewScope();
  const ret = x * y; // 7
  s = s.leaveScope();
  return ret;
}
