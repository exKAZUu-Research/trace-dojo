<?php
function printFreshHandle() { echo spl_object_id(new stdClass), "\n"; }
class Numbers implements IteratorAggregate {
    function getIterator(): Traversable { return new ArrayIterator([1, 2]); }
}
class WithHandle implements Iterator {
    private int $i = 0;
    function rewind(): void { $this->i = 0; }
    function valid(): bool { return $this->i < 1; }
    function current(): mixed { return spl_object_id(new stdClass); }
    function key(): mixed { return $this->i; }
    function next(): void { $this->i++; }
}
$numbers = new Numbers;
var_dump(iterator_to_array($numbers));
printFreshHandle();
var_dump([...$numbers]);
printFreshHandle();
foreach ($numbers as $value) break;
printFreshHandle();
$iterator = new WithHandle;
var_dump(iterator_to_array($iterator), [...$iterator]);
$fixed = new SplFixedArray(2);
foreach ($fixed as $value) printFreshHandle();
printFreshHandle();
$inner = $fixed->getIterator();
var_dump(spl_object_id($inner), iterator_to_array($inner));
unset($inner);
printFreshHandle();

foreach ([false, true] as $proceed) {
    $applying = new ArrayIterator([1, 2]);
    echo iterator_apply($applying, fn () => $proceed), ':';
    printFreshHandle();
    unset($applying);
}
try {
    iterator_apply(new ArrayIterator([1, 2]), function () { throw new Exception('stop'); });
} catch (Exception $error) { echo $error->getMessage(), "\n"; }
printFreshHandle();

class InheritedIterator extends ArrayObject {}
function packIterator(...$values) {}
foreach ([new ArrayObject([1, 2]), new InheritedIterator([3])] as $collection) {
    foreach ($collection as $value) {}
    printFreshHandle();
    foreach ($collection as $value) { printFreshHandle(); break; }
    printFreshHandle();
    var_dump(iterator_to_array($collection), [...$collection]);
    printFreshHandle();
    packIterator(...$collection);
    printFreshHandle();
}

function freshArrayObject() { return new ArrayObject([7]); }
function iterateTemporary($kind) {
    if ($kind === 'object') foreach (new ArrayObject([1]) as $value) {}
    if ($kind === 'function') foreach (freshArrayObject() as $value) {}
    if ($kind === 'method') foreach ((new ArrayObject([2]))->getIterator() as $value) {}
    if ($kind === 'iterator') foreach (new ArrayIterator([3]) as $value) {}
    if ($kind === 'fixed') foreach (new SplFixedArray(1) as $value) {}
    if ($kind === 'queue') foreach (new SplQueue as $value) {}
    var_dump(spl_object_id($first = new stdClass), spl_object_id(new stdClass));
}
foreach (['object','function','method','iterator','fixed','queue'] as $kind) iterateTemporary($kind);
class TemporaryAggregate implements IteratorAggregate {
    function getIterator(): Traversable { echo 'get;'; return new VisibleRewind([1]); }
    function __destruct() { echo 'aggregate;'; }
}
class VisibleRewind extends ArrayIterator {
    function rewind(): void { echo 'rewind;'; parent::rewind(); }
    function __destruct() { echo 'iterator;'; }
}
foreach (new TemporaryAggregate as $value) echo 'body;';
echo "end;\n";
printFreshHandle();
