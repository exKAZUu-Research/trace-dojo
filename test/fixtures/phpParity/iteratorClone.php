<?php
class MyLimit extends LimitIterator {}
foreach ([new LimitIterator(new ArrayIterator([1])), new MyLimit(new ArrayIterator([1])), new RecursiveIteratorIterator(new RecursiveArrayIterator([])), new AppendIterator(), new EmptyIterator()] as $it) {
    try { $c = clone $it; echo "cloned ", get_class($c), "\n"; } catch (Error $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
}
$m = new MultipleIterator();
$m->attachIterator(new ArrayIterator([1, 2]));
$m2 = clone $m;
var_dump($m2->countIterators());
