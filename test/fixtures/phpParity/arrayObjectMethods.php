<?php
$ao = new ArrayObject(['b' => 2, 'a' => 1, 'c' => 3]);
var_dump($ao->getFlags(), $ao->getIteratorClass());
$old = $ao->exchangeArray(['x' => 9]);
print_r($old); print_r($ao->getArrayCopy());
var_dump(count($ao));
$ao->setFlags(ArrayObject::STD_PROP_LIST);
var_dump($ao->getFlags());
var_dump(ArrayObject::STD_PROP_LIST, ArrayObject::ARRAY_AS_PROPS, ArrayIterator::STD_PROP_LIST, ArrayIterator::ARRAY_AS_PROPS);
$n = new ArrayObject(['img12.png', 'img10.png', 'IMG2.png', 'img1.png']);
$n->natsort(); print_r($n->getArrayCopy());
$n->natcasesort(); print_r($n->getArrayCopy());
$it = new ArrayIterator(['img12.png', 'img10.png', 'img2.png']);
$it->natsort(); print_r($it->getArrayCopy());
var_dump($it->getFlags());
$it->setFlags(5); var_dump($it->getFlags());
$it->setFlags(0x10000 | 1); var_dump($it->getFlags());
class MyIt extends ArrayIterator {}
$ao = new ArrayObject([3, 1, 2], 0, 'MyIt');
var_dump($ao->getIteratorClass(), get_class($ao->getIterator()));
$ao->setIteratorClass('ArrayIterator');
var_dump($ao->getIteratorClass());
try { $ao->setIteratorClass('stdClass'); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { new ArrayObject([], 0, 'Nope'); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
$ao->asort(); print_r($ao->getArrayCopy());
$ao->uasort(fn($a, $b) => $b <=> $a); print_r($ao->getArrayCopy());
$ao->uksort(fn($a, $b) => $a <=> $b); print_r($ao->getArrayCopy());
$s = new ArrayObject(['10', 9, '9a', 1.5]);
$s->asort(SORT_STRING); print_r($s->getArrayCopy());
$s->ksort(SORT_REGULAR); print_r($s->getArrayCopy());
$a2 = new ArrayObject([1, 2], ArrayObject::STD_PROP_LIST);
var_dump($a2->getFlags());
$a3 = new ArrayObject($a2);
var_dump($a3->getFlags());
$a4 = new ArrayObject($a2, 0);
var_dump($a4->getFlags());
$x = new ArrayObject([1]);
$x->exchangeArray(new ArrayObject([5, 6]));
var_dump($x->getArrayCopy(), $x->getFlags());
var_dump(get_class_methods('ArrayObject') == get_class_methods($x));
print_r(array_diff(get_class_methods("ArrayIterator"), ["__debugInfo"]));

foreach (['write', 'unset', 'exists'] as $operation) {
    $live = new ArrayObject(['old' => 1]);
    set_error_handler(function () use ($live) { $live->exchangeArray([1 => 2]); return true; });
    if ($operation === 'write') $live[1.5] = 7;
    elseif ($operation === 'unset') unset($live[1.5]);
    else var_dump($live->offsetExists(1.5));
    restore_error_handler();
    var_dump($live->getArrayCopy());
}

class ReusableArrayIterator extends ArrayIterator {
    function replace(array $values): void { parent::__construct($values); }
}
$reusable = new ReusableArrayIterator(['old']);
$reusable->next();
$reusable->replace(['new']);
var_dump($reusable->valid(), $reusable->key(), $reusable->current());
