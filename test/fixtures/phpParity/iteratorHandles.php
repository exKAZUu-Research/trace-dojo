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
