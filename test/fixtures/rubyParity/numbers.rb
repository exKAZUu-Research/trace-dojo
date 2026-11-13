p 7.0 / 2, 7 / 2.0, 7.fdiv(2), 7.divmod(2), -7.divmod(2), 7.5.divmod(2), 2**64, 2**0.5, 10.0**20, 4**0.5
p 3.14159.round(2), 3.5.round, 2.5.round, -2.5.round, 1234.5678.round(-2), 1234.round(-2), 1250.round(-2), 3.7.floor, -3.7.ceil, 3.7.truncate, 3.14159.floor(2), 3.14159.ceil(2)
p 10.gcd(4), 10.lcm(4), 255.to_s(2), 255.to_s(16), 10.digits, 5.pred, 5.succ, -5.abs, 5.0.abs, 3.zero?, 0.zero?
p 1000.0.to_i, 12.5.to_i, 1.0 / 3, 2.0 / 3, 0.1 + 0.2, 1.1 * 3, 100.0, 0.00001, 123456789.123456789, 1.23 * 10.0**30
p 10.between?(1, 10), 5.clamp(1, 3), 15 % 4, -15 % 4, 15.remainder(-4), 2**100 % 7, (2**100).to_s.length
p Integer.sqrt(26), Math.sqrt(16), Math.sqrt(2), Math::PI, Math.hypot(3, 4), Math.log(Math::E), Math.log2(8), Math.log10(1000), Math.log(8, 2), Math.cbrt(27)
p Math.sin(0), Math.cos(0), Math.atan2(1, 1), Math.exp(1), Math.pow(2,3) rescue p $!.class
p 1.0.nan?, (0.0 / 0.0).nan?, (1.0 / 0), -1.0 / 0, Float::INFINITY > 10**100, 0.1 * 3 == 0.3, (0.1 * 3 - 0.3).abs < Float::EPSILON
p 3.7 % 1, -3.7 % 1, 5.0.div(2)
p 1_000_000, 12.34.to_s, 5.to_f, 3.0.to_i, 7.0.floor, 7.9.to_i, 6.0 * 7, 100.to_s.rjust(6, "0"), 0.00000000015
p 10.times.to_a, 1.upto(4).to_a, 4.downto(1).map { |i| i * 2 }, 1.step(10, 3).to_a, 1.0.step(2.0, 0.5).to_a, 10.step(1, -4).to_a
p 3.even?, 3.odd?, 0.positive?, -1.negative?, 2 <=> 3, 3.0 <=> 3, 1 == 1.0, 1.eql?(1.0), 1.equal?(1), 17.0.to_s, (10.0**16).to_i
p 12345678901234567890 * 98765432109876543210, -(2**70) / 3, (2**70).to_f, 10**20 / 10**18
p Integer("42"), Integer("0b11"), Integer("0o17"), Integer("017"), Integer(" 10 "), Float("3.5"), Float("1e2"), Integer(3.99), Integer("z", exception: false)
p 1.0.round(1), 0.5.round(half: :even), 1.5.round(half: :even), 2.5.round(half: :down), 25.round(-1, half: :even), 1.15.round(1), 1.25.round(1), 1.35.round(1), 2.675.round(2)
p (1..10).sum, (1..10).step(2).to_a, 1.0.to_s, 3.0 * 1.1, 100.digits.sum, 6.0221 * 10.0**23, 9007199254740993, 0.1.to_s, -0.0
p 255.chr, 65.chr, "A".ord + 1, 3.14.to_i, 3.99.round, -3.5.round, 3.5.floor, rand(1), [1.5, 2.5].sum, [0.1] * 3 == [0.1, 0.1, 0.1], [0.1, 0.2, 0.3].sum, [1, 2.5].sum
