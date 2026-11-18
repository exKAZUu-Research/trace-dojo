<?php
var_dump(levenshtein('', 'x', PHP_INT_MAX));
var_dump(levenshtein('x', '', 1, 1, 9007199254740993));
var_dump(levenshtein('x', 'y', 9007199254740994, 9007199254740993, 9007199254740994));
var_dump(levenshtein('', 'xx', PHP_INT_MAX), levenshtein('a', 'bbb', PHP_INT_MAX, PHP_INT_MAX, PHP_INT_MAX));

$iterator = new MultipleIterator(9007199254740993);
$iterator->attachIterator(new ArrayIterator([1]));
$iterator->attachIterator(new ArrayIterator([]));
$iterator->rewind();
var_dump($iterator->getFlags(), $iterator->valid());
$iterator->setFlags(PHP_INT_MAX);
var_dump($iterator->getFlags(), $iterator->valid());

error_reporting(E_ALL & ~E_DEPRECATED);
$object = (object) ['a' => 1, 'b' => 2, 'c' => 3];
next($object);
unset($object->b);
var_dump(key($object), current($object));
unset($object->c);
var_dump(key($object), current($object), next($object));
$object->{'15'} = 4;
var_dump(key($object), current($object), prev($object), key($object));

class DeclaredProps {
    private int $first = 1;
    protected int $second = 2;
    public int $third = 3;
    public function removeSecond() { unset($this->second); }
    public function addSecond() { $this->second = 4; }
}
$object = new DeclaredProps;
var_dump(bin2hex(key($object)), next($object), bin2hex(key($object)));
$object->removeSecond();
var_dump(key($object), current($object));
$object->addSecond();
var_dump(key($object), prev($object), bin2hex(key($object)));
