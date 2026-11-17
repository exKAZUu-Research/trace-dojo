<?php
class Tr implements Iterator {
    private $i = 0;
    public function __construct(private array $a, private string $n = 'T') {}
    public function rewind(): void { echo "$this->n.rewind\n"; $this->i = 0; }
    public function valid(): bool { echo "$this->n.valid\n"; return $this->i < count($this->a); }
    public function current(): mixed { echo "$this->n.current\n"; return $this->a[$this->i]; }
    public function key(): mixed { echo "$this->n.key\n"; return $this->i; }
    public function next(): void { echo "$this->n.next\n"; $this->i++; }
}
class Seek extends Tr implements SeekableIterator {
    public function seek(int $o): void { echo "seek $o\n"; for ($this->rewind(); $o-- > 0; $this->next()); }
}
echo "== caching\n";
$c = new CachingIterator(new Tr([1, 2]));
foreach ($c as $v) { echo "got $v ", var_export($c->hasNext(), true), "\n"; }
echo "== norewind\n";
$n = new NoRewindIterator(new Tr([1, 2]));
var_dump($n->current(), $n->current(), $n->key());
foreach ($n as $v) echo "got $v\n";
echo "== append\n";
$ap = new AppendIterator();
$ap->append(new Tr([1], 'A'));
$ap->append(new Tr([2], 'B'));
foreach ($ap as $k => $v) echo "got $k $v\n";
echo "== filter\n";
$f = new CallbackFilterIterator(new Tr([1, 2, 3]), fn($v) => $v != 2);
foreach ($f as $v) echo "got $v\n";
echo "== limit seekable\n";
$l = new LimitIterator(new Seek([1, 2, 3, 4]), 2, 1);
foreach ($l as $v) echo "got $v\n";
echo "== infinite\n";
$i = new InfiniteIterator(new Tr([1, 2]));
$n = 0;
foreach ($i as $v) { echo "got $v\n"; if (++$n == 3) break; }
echo "== multiple\n";
$m = new MultipleIterator(MultipleIterator::MIT_NEED_ANY);
$m->attachIterator(new Tr([1], 'A'));
$m->attachIterator(new Tr([1, 2], 'B'));
foreach ($m as $k => $v) echo "got ", json_encode($k), json_encode($v), "\n";
echo "== to_array\n";
print_r(iterator_to_array(new LimitIterator(new ArrayIterator(range(1, 5)), 1, 3)));
echo iterator_count(new CallbackFilterIterator(new ArrayIterator(range(1, 10)), fn($x) => $x & 1)), "\n";
