<?php
interface HasArea { const UNITS = 'cm'; public function area(): float; }
interface Printable extends Stringable {}
class Rect implements HasArea, Printable, Countable, ArrayAccess, IteratorAggregate, JsonSerializable {
    private array $data = [];
    public function __construct(private float $w, private float $h) {}
    public function area(): float { return $this->w * $this->h; }
    public function __toString(): string { return "Rect({$this->w}x{$this->h})"; }
    public function count(): int { return 4; }
    public function offsetExists(mixed $o): bool { return isset($this->data[$o]); }
    public function offsetGet(mixed $o): mixed { return $this->data[$o] ?? "none"; }
    public function offsetSet(mixed $o, mixed $v): void { if ($o === null) $this->data[] = $v; else $this->data[$o] = $v; }
    public function offsetUnset(mixed $o): void { unset($this->data[$o]); }
    public function getIterator(): Iterator { return new ArrayIterator(['w' => $this->w, 'h' => $this->h]); }
    public function jsonSerialize(): mixed { return ['w' => $this->w, 'h' => $this->h, 'units' => self::UNITS]; }
}
$r = new Rect(2, 3);
echo $r, " ", $r->area(), " ", count($r), " ", Rect::UNITS, " ", HasArea::UNITS, "\n";
$r['x'] = 5; $r[] = 6; echo $r['x'], $r['y'], isset($r['x']) ? 'Y' : 'N', isset($r['z']) ? 'Y' : 'N', "\n"; unset($r['x']); echo $r['x'], "\n";
foreach ($r as $k => $v) echo "$k=$v,"; echo "\n";
echo json_encode($r), " ", $r instanceof Stringable ? 'S' : '-', $r instanceof Traversable ? 'T' : '-', "\n";
class Counter implements Iterator {
    private int $i = 0;
    public function __construct(private array $items) {}
    public function current(): mixed { return $this->items[$this->i]; }
    public function key(): mixed { return $this->i; }
    public function next(): void { $this->i++; }
    public function rewind(): void { $this->i = 0; }
    public function valid(): bool { return $this->i < count($this->items); }
}
foreach (new Counter(['a', 'b']) as $k => $v) echo "$k:$v "; echo "\n";
echo implode(",", iterator_to_array(new Counter([1, 2]))), "\n";
abstract class Animal {
    public function __construct(protected string $name) {}
    abstract protected function sound(): string;
    public function speak(): string { return "{$this->name} says {$this->sound()}"; }
    public static function make(string $name): static { return new static($name); }
}
class Dog extends Animal { protected function sound(): string { return "Woof"; } }
class Puppy extends Dog { protected function sound(): string { return parent::sound() . "!"; } }
echo Dog::make("Rex")->speak(), " | ", (new Puppy("Bit"))->speak(), " | ", get_parent_class(new Puppy("x")), "\n";
var_dump(new Puppy("p") instanceof Animal, is_a(new Dog("d"), 'Animal'), is_subclass_of('Puppy', 'Dog'), method_exists('Dog', 'speak'), property_exists('Animal', 'name'));
trait Greets { public $greeting = "Hello"; public function greet() { return "$this->greeting from " . static::class . " " . self::class . " " . __CLASS__ . " " . __TRAIT__; } public static function create() { return new static(); } }
trait Logs { private array $log = []; public function log($m) { $this->log[] = $m; return count($this->log); } }
class Person { use Greets, Logs; }
$p = Person::create(); echo $p->greet(), " ", $p->log("a"), $p->log("b"), "\n";
class Config { private static ?Config $instance = null; private array $settings = []; private function __construct() {} public static function get(): static { return self::$instance ??= new static(); } public function set($k, $v) { $this->settings[$k] = $v; return $this; } public function all() { return $this->settings; } }
Config::get()->set('a', 1)->set('b', 2); print_r(Config::get()->all()); var_dump(Config::get() === Config::get());
try { new Config(); } catch (Error $e) { echo $e->getMessage(), "\n"; }
class Money { public function __construct(public readonly int $amount) {} public function add(Money $o): static { return new static($this->amount + $o->amount); } }
$m = (new Money(5))->add(new Money(7)); echo $m->amount, "\n";
try { $m->amount = 1; } catch (Error $e) { echo $e->getMessage(), "\n"; }
$cl = function() { return $this->amount; }; echo Closure::bind($cl, $m, Money::class)(), " ", $cl->call(new Money(3)), "\n";
$fn = function($x) { return $x + $this->amount; }; $bound = $fn->bindTo(new Money(10)); echo $bound(5), "\n";
class StaticCounter { public static int $count = 0; public static function inc(): int { return ++static::$count; } }
StaticCounter::inc(); StaticCounter::inc(); echo StaticCounter::$count, "\n";
class Base { public function __call($name, $args) { return "$name:" . count($args); } }
echo (new Base)->anything(1, 2, 3), "\n";
$obj = new stdClass; $obj->a = 1; $obj->b = [1, 2]; $obj2 = clone $obj; $obj2->a = 2; echo $obj->a, $obj2->a, "\n";
var_dump($obj == $obj2, (array)$obj, (object)['x' => 1]);
$arr = ['k' => 'v']; $o = (object)$arr; echo $o->k, "\n";
printf("%s %s %s\n", get_class($r), gettype($r), get_debug_type($r));
echo $r::UNITS, " ", $r::class, "\n";

trait TraitMagicDefaults {
    const TRAIT_NAME = __TRAIT__;
    public string $traitName = __TRAIT__ . ' instance';
    public static string $staticTrait = __TRAIT__ . ' static';
    public string $owner = __CLASS__;
}
class MagicUsingClass { use TraitMagicDefaults; }
echo MagicUsingClass::TRAIT_NAME, ';', MagicUsingClass::$staticTrait, ';';
$instance = new MagicUsingClass;
echo $instance->traitName, ';', $instance->owner, "\n";
