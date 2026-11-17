Point = Struct.new(:x, :y) do
  def dist = Math.sqrt(x * x + y * y)
  def to_s = "(#{x}, #{y})"
end
a = Point.new(3, 4)
p a, a.x, a[1], a[:y], a["x"], a.dist, a.to_a, a.to_h, a.members, Point.members, a == Point.new(3, 4), a.eql?(Point.new(3, 4.0))
puts a
a.x = 10
a[:y] = 20
p a, a.size, a.each.to_a, Point.new(1), Point.new(x: 5, y: 6) rescue p $!
begin; Point.new(1, 2, 3); rescue ArgumentError => e; p e.message; end
begin; a[:z]; rescue NameError => e; p e.message; end
h = { Point.new(1, 2) => :first }
p h[Point.new(1, 2)], h[Point.new(2, 1)]
K = Struct.new(:name, :age, keyword_init: true)
k = K.new(name: "Al", age: 3)
p k, k.name
S = Struct.new(:v)
p S.new([1, 2]).dig(:v, 0), [S.new(2), S.new(1)].sort_by(&:v).map(&:v), S.new(nil)
Coord = Data.define(:lat, :lng) do
  def to_s = "#{lat},#{lng}"
end
c = Coord.new(lat: 1.5, lng: 2)
d = Coord.new(3, 4)
p c, d, c.lat, c.to_h, c.with(lng: 9), c == Coord.new(lat: 1.5, lng: 2), c.frozen?
puts c
begin; Coord.new(1); rescue ArgumentError => e; p e.message; end
begin; c.instance_variable_set(:@lat, 2); rescue => e; p e.class; end
p Struct.new(:a).new(1).inspect
