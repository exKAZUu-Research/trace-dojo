<?php
abstract class Shape {
    protected static int $count = 0;
    const SIDES = 0;
    public function __construct(protected string $name) { static::$count++; self::log("created $name"); }
    abstract public function area(): float;
    public static function count(): int { return static::$count; }
    private static function log(string $m): void { echo "[log] $m\n"; }
    public function describe(): string { return sprintf("%s with area %.2f and %d sides", $this->name, $this->area(), static::SIDES); }
    public function __toString(): string { return $this->describe(); }
}
interface HasPerimeter { public function perimeter(): float; }
trait Named { public function getName(): string { return strtoupper($this->name); } }
class Circle extends Shape implements HasPerimeter {
    use Named;
    public function __construct(private float $r) { parent::__construct("circle"); }
    public function area(): float { return M_PI * $this->r ** 2; }
    public function perimeter(): float { return 2 * M_PI * $this->r; }
}
final class Square extends Shape {
    const SIDES = 4;
    public function __construct(public readonly float $side) { parent::__construct("square"); }
    public function area(): float { return $this->side ** 2; }
    public static function create(float $s): static { return new static($s); }
}
$c = new Circle(2); $s = Square::create(3);
echo "#", spl_object_id(new stdClass), "\n";
echo $c, "\n", $s, "\n", Shape::count(), " ", $c->getName(), " ", $c instanceof HasPerimeter ? 'yes' : 'no', "\n";
echo "#", spl_object_id(new stdClass), "\n";
printf("%.3f\n", $c->perimeter());
echo "#", spl_object_id(new stdClass), "\n";
try { $s->side = 5; } catch (Error $e) { echo get_class($e), ": ", $e->getMessage(), "\n"; }
try { new Shape("x"); } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { echo $c->r; } catch (Error $e) { echo $e->getMessage(), "\n"; }
class Magic {
    private array $data = [];
    public function __get($n) { echo "get $n\n"; return $this->data[$n] ?? null; }
    public function __set($n, $v) { echo "set $n\n"; $this->data[$n] = $v; }
    public function __isset($n) { return isset($this->data[$n]); }
    public function __unset($n) { unset($this->data[$n]); }
    public function __call($m, $args) { return "$m(" . implode(",", $args) . ")"; }
    public static function __callStatic($m, $args) { return "static $m"; }
    public function __invoke($x) { return $x * 2; }
}
$m = new Magic; $m->foo = 5; echo $m->foo, "\n"; var_dump(isset($m->foo), isset($m->bar)); unset($m->foo); var_dump(isset($m->foo));
echo "#", spl_object_id(new stdClass), "\n";
echo $m->doThing(1, 2), " ", Magic::other(), " ", $m(21), "\n";
echo "#", spl_object_id(new stdClass), "\n";
class Node { public $children = []; public function __construct(public $value) {} public function __clone() { foreach ($this->children as $k => $c) $this->children[$k] = clone $c; } }
$n1 = new Node(1); $n1->children[] = new Node(2); $n2 = clone $n1; $n2->children[0]->value = 99; echo $n1->children[0]->value, $n2->children[0]->value, "\n";
echo "#", spl_object_id(new stdClass), "\n";
$anon = new class(5) { public function __construct(public int $v) {} public function double() { return $this->v * 2; } };
echo "#", spl_object_id(new stdClass), "\n";
echo $anon->double(), " ", (new class { public $x = 'anon'; })->x, "\n";
echo "#", spl_object_id(new stdClass), "\n";
class A { public static function create() { return new static(); } public function who() { return static::class; } }
class B extends A {}
echo get_class(B::create()), (new B)->who(), A::class, "\n";
echo "#", spl_object_id(new stdClass), "\n";
$obj = null; echo $obj?->foo?->bar ?? 'nullsafe', "\n";
echo "#", spl_object_id(new stdClass), "\n";
class Temp { public function __construct(public float $c) {} public float $f { get => $this->c * 9 / 5 + 32; } }
echo (new Temp(100))->f, "\n";
echo "#", spl_object_id(new stdClass), "\n";
class Pt { public function __construct(public int $x = 0, public int $y = 0) {} }
$p = new Pt(1, 2); $q = $p; $q->x = 10; echo $p->x, "\n"; var_dump($p == new Pt(10, 2), $p === $q);
echo "#", spl_object_id(new stdClass), "\n";
print_r($p); var_dump($p);
echo "#", spl_object_id(new stdClass), "\n";
echo json_encode($p), "\n";
echo "#", spl_object_id(new stdClass), "\n";
foreach ($p as $k => $v) echo "$k=$v ";
echo "#", spl_object_id(new stdClass), "\n";
echo "\n";
echo "#", spl_object_id(new stdClass), "\n";
