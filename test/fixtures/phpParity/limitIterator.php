<?php
$a = new ArrayIterator(['a', 'b', 'c', 'd', 'e', 'f']);
foreach (new LimitIterator($a, 2, 3) as $k => $v) echo "$k=>$v\n";
$l = new LimitIterator($a, 1, 2);
foreach ($l as $k => $v) echo "$k=>$v ", $l->getPosition(), "\n";
var_dump($l->seek(2), $l->current(), $l->getPosition());
try { $l->seek(0); } catch (OutOfBoundsException $e) { echo $e->getMessage(), "\n"; }
try { $l->seek(5); } catch (OutOfBoundsException $e) { echo $e->getMessage(), "\n"; }
try { new LimitIterator($a, -1); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { new LimitIterator($a, 0, -2); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
foreach (new LimitIterator($a, 4) as $k => $v) echo "$k=>$v\n";
try { foreach (new LimitIterator($a, 10) as $k => $v) echo "$k=>$v\n"; } catch (Exception $e) { echo get_class($e), ": ", $e->getMessage(), "\n"; }
try { foreach (new LimitIterator($a, 0, 0) as $k => $v) echo "$k=>$v\n"; } catch (Exception $e) { echo get_class($e), ": ", $e->getMessage(), "\n"; }
class Tr implements Iterator {
    private $i = 0;
    public function __construct(private array $a) {}
    public function rewind(): void { echo "rewind\n"; $this->i = 0; }
    public function valid(): bool { echo "valid\n"; return $this->i < count($this->a); }
    public function current(): mixed { echo "current\n"; return $this->a[$this->i]; }
    public function key(): mixed { echo "key\n"; return $this->i; }
    public function next(): void { echo "next\n"; $this->i++; }
}
foreach (new LimitIterator(new Tr([1, 2, 3, 4]), 1, 2) as $k => $v) echo "$k=>$v\n";
$l = new LimitIterator(new Tr([1, 2, 3, 4]), 1);
echo $l->seek(3), "\n";
var_dump($l->current());
print_r($l); echo "\n";
print_r(get_class_methods($l));
