h = {}.compare_by_identity
a = "k"
h[a] = 1
h["k".dup] = 2
p h.size, h[a], h["k"], h.compare_by_identity?, {}.compare_by_identity?
h2 = {1 => :x}.compare_by_identity
p h2[1], h2
k = "z"
h3 = {}.compare_by_identity
h3[k] = 1
d = h3.dup
p d[k], d.compare_by_identity?, h3.keys[0].frozen?
