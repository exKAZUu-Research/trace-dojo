<?php
class Tr implements Iterator {
    private $i = 0;
    public function __construct(private array $a) {}
    public function rewind(): void { echo "rewind\n"; $this->i = 0; }
    public function valid(): bool { echo "valid\n"; return $this->i < count($this->a); }
    public function current(): mixed { echo "current\n"; return $this->a[$this->i]; }
    public function key(): mixed { echo "key\n"; return $this->i; }
    public function next(): void { echo "next\n"; $this->i++; }
}
$it = new IteratorIterator(new Tr([10, 20]));
foreach ($it as $k => $v) echo "$k=>$v\n";
echo "--\n";
$it->rewind();
var_dump($it->valid(), $it->current(), $it->key());
$it->next(); $it->next();
var_dump($it->valid(), $it->current(), $it->key());
$ao = new ArrayObject(['a' => 1, 'b' => 2]);
$ii = new IteratorIterator($ao);
foreach ($ii as $k => $v) echo "$k=$v\n";
var_dump(get_class($ii->getInnerIterator()));
var_dump($ii);
print_r($ii); echo "\n";
print_r(class_implements($ii));
print_r(get_class_methods('IteratorIterator'));
print_r(class_implements('OuterIterator'));
print_r(class_implements('RecursiveIterator'));
print_r(get_class_methods('OuterIterator'));
print_r(get_class_methods('RecursiveIterator'));
var_dump(iterator_to_array(new IteratorIterator(new ArrayIterator([3, 4, 5]))));
try { $x = new IteratorIterator(new ArrayObject([]), 'Foo'); } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
class Sub extends IteratorIterator { function __construct() {} }
try { (new Sub)->rewind(); } catch (Error $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
class Sub2 extends IteratorIterator { function current(): mixed { return parent::current() * 2; } }
foreach (new Sub2(new ArrayIterator([1, 2])) as $k => $v) echo "$k:$v\n";
