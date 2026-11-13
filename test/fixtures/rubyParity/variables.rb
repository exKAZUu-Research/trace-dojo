x = 10
y = x
x += 5
p x, y
a, b = 1, 2
a, b = b, a
p a, b
c, *d = [1, 2, 3]
p c, d
*e, f = 1, 2, 3
p e, f
g, h = 5
p g, h
i = j = 7
p i, j
k = 1, 2
p k
p 1
$glob = 3
$glob += 1
p $glob
CONST = 42
p CONST
@top = 1
p @top
p((defined_later rescue $!.class))
def defined_later = :ok
p defined_later
q = nil
q ||= 5
q &&= q + 1
p q
r = [1, 2]
r[5] ||= 9
p r
s = "a"
s *= 3
p s
t = 10
t -= 1; t *= 2; t /= 3; t %= 4; t **= 3
p t

