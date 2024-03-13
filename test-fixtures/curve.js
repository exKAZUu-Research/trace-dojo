s.set('t', new Turtle());
for (s.set('i', 0); s.get('i') < 2; s.set('i', s.get('i') + 1)) {
  s.get('t').forward();
  s.get('t').forward();
  s.get('t').rotateRight();
}
