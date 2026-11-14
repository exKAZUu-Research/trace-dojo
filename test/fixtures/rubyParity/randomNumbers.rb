srand(42)
p rand, rand(10), rand(1..6), rand(1.5), rand(2.0..3.0), rand(10**20)
p Array.new(5) { rand(100) }
r = Random.new(123)
p r.rand, r.rand(50), r.rand(1...10), r.rand(0.5), r.seed
p [1, 2, 3, 4, 5].shuffle(random: Random.new(1)), [1, 2, 3, 4, 5].sample(random: Random.new(2)), (1..30).to_a.sample(12, random: Random.new(9))
srand(7)
p [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].shuffle, [1, 2, 3].sample, (1..50).to_a.sample(5), Random.rand(10), Random.rand
p srand(1), srand(2)
p rand(-5), rand(0), rand(nil) rescue p $!
