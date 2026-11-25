<?php
// by-reference generator
function &refs(array &$arr) { foreach ($arr as $k => &$v) { yield $k => $v; } }
$data = [1, 2, 3];
foreach (refs($data) as &$v) { $v *= 10; }
unset($v);
print_r($data);
function &notvar() { yield 1; }
foreach (notvar() as $x) echo $x, "\n";
// generator in class with $this and static
class Coll implements IteratorAggregate {
    private $items = ['a' => 1, 'b' => 2];
    public function getIterator(): Generator { foreach ($this->items as $k => $v) yield $k => $v; }
    public static function range($a, $b) { for ($i = $a; $i <= $b; $i++) yield $i; }
}
foreach (new Coll as $k => $v) echo "$k=$v\n";
echo implode(',', iterator_to_array(Coll::range(1, 5))), "\n";
// static vars in generator
function st() { static $n = 0; $n++; yield $n; }
foreach (st() as $v) echo $v; foreach (st() as $v) echo $v; echo "\n";
// infinite generator with break
function nat() { $i = 0; while (true) yield $i++; }
foreach (nat() as $n) { if ($n > 4) break; echo $n; } echo "\n";
// keys after explicit int keys
function keys() { yield 5 => 'a'; yield 'b'; yield 2 => 'c'; yield 'd'; yield -10 => 'e'; yield 'f'; }
foreach (keys() as $k => $v) echo "$k:$v "; echo "\n";
// yield from iterator aggregate and ArrayIterator
function yf() { yield from new ArrayIterator(['x' => 1, 'y' => 2]); yield from new Coll; return 7; }
$g = yf(); foreach ($g as $k => $v) echo "$k=$v "; echo $g->getReturn(), "\n";
// yield from non-iterable
function bad() { yield from 5; }
try { foreach (bad() as $v) {} } catch (Error $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
// generator returning without yield executed
function early($x) { if ($x) return 'early'; yield 1; }
$e = early(true); var_dump($e->valid(), $e->getReturn());
// nested generators chaining
function mapG(callable $f, iterable $it) { foreach ($it as $k => $v) yield $k => $f($v); }
function filterG(callable $f, iterable $it) { foreach ($it as $k => $v) if ($f($v)) yield $k => $v; }
foreach (mapG(fn($x) => $x * $x, filterG(fn($x) => $x % 2, [1, 2, 3, 4, 5])) as $k => $v) echo "$k=>$v ";
echo "\n";
// uncaught exception from generator
function boom() { yield 1; throw new LogicException("bad"); }
foreach (boom() as $v) echo $v, "\n";
