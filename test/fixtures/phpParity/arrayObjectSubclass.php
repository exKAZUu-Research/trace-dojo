<?php
class Bag extends ArrayObject {
    public $label = 'bag';
    protected $p = 1;
    private $q = 2;
}
$b = new Bag(['a' => 1]);
var_dump($b);
print_r($b); echo "\n";
class It extends ArrayIterator { public $z = 0; }
var_dump(new It([1]));
$r = new RecursiveArrayIterator([[1]]);
var_dump($r->getChildren());
$c = clone $b;
var_dump(count($c), $c->getArrayCopy());
