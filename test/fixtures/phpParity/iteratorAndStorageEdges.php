<?php
foreach (['ArrayObject', 'ArrayIterator'] as $type) {
    $array = new $type([3, 2, 1]);
    $calls = 0;
    $array->uasort(function ($left, $right) use ($array, &$calls) {
        if (++$calls === 1) { $array->asort(); echo implode(',', $array->getArrayCopy()), "\n"; }
        return $left <=> $right;
    });
    echo implode(',', $array->getArrayCopy()), "\n";
}
class Wrapper implements IteratorAggregate {
    function __construct(public ?Traversable $inner = null) {}
    function getIterator(): Traversable { return $this->inner ?? $this; }
}
$iterator = new ArrayIterator([1, 2]);
for ($i = 0; $i < 40; ++$i) $iterator = new Wrapper($iterator);
foreach ($iterator as $value) echo $value;
echo "\n";
try { foreach (new Wrapper as $value) {} } catch (Exception $error) { echo $error->getMessage(), "\n"; }
try { $result = [PHP_INT_MAX => 1, ...new ArrayIterator([2])]; }
catch (Error $error) { echo $error->getMessage(), "\n"; }
$s = new SplObjectStorage;
$a = new stdClass;
$b = new stdClass;
$c = new stdClass;
$s[$a] = 1;
$s[$b] = 2;
$s[$c] = 3;
$s->rewind();
$s->next();
unset($s[$b]);
var_dump($s->key(), $s->getInfo());
$s->offsetUnset($b);
var_dump($s->key(), $s->getInfo());
$s->next();
$s->offsetUnset($c);
var_dump($s->key(), $s->getInfo());
