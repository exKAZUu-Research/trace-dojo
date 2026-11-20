<?php
class Element {
    function __construct(public $position) {}
    function __destruct() { echo "drop$this->position;"; }
}
class FreshElements implements Iterator {
    private $position = 0;
    function rewind(): void { echo 'rewind;'; $this->position = 0; }
    function valid(): bool { return $this->position < 2; }
    function current(): mixed { echo 'current;'; return new Element($this->position); }
    function key(): mixed { return $this->position; }
    function next(): void { echo 'next;'; $this->position++; }
}
foreach (['NoRewindIterator', 'IteratorIterator', 'InfiniteIterator', 'LimitIterator'] as $wrapper) {
    $iterator = new $wrapper(new FreshElements);
    $iterator->rewind();
    $held = $iterator->current();
    unset($held);
    echo $iterator->current()->position, ';before;';
    $iterator->next();
    echo 'after;';
    unset($iterator);
    echo "\n";
}
class SeekableElements implements SeekableIterator {
    function rewind(): void {}
    function valid(): bool { return true; }
    function current(): mixed { return 1; }
    function key(): mixed { return 0; }
    function next(): void {}
    function seek(int $offset): void { echo 'seek:', $offset, ';'; }
}
$iterator = new LimitIterator(new SeekableElements, 9007199254740993);
$iterator->rewind();
var_dump($iterator->getPosition(), $iterator->seek(9007199254740995));
$iterator = new LimitIterator(new SeekableElements, PHP_INT_MAX);
$iterator->rewind();
var_dump($iterator->getPosition());
$iterator->next();
var_dump($iterator->getPosition());

class ObjectKeyElements implements Iterator {
    function rewind(): void {}
    function valid(): bool { return true; }
    function current(): mixed { return new Element('value'); }
    function key(): mixed { return new Element('key'); }
    function next(): void {}
}
foreach (['IteratorIterator', 'LimitIterator', 'InfiniteIterator'] as $wrapper) {
    $iterator = new $wrapper(new ObjectKeyElements);
    $iterator->rewind();
    $iterator->next();
    echo 'unset;';
    unset($iterator);
    echo "\n";
}
