<?php
foreach([false,true] as $backed){$o=new ArrayObject(['a','b','c']);$i=$backed?$o->getIterator():new ArrayIterator(['a','b','c']);$source=$backed?$o:$i;$i->next();unset($source[0]);var_dump($i->key(),$i->current());unset($source[1]);var_dump($i->key(),$i->current());$source[1]='new';$i->next();var_dump($i->key(),$i->current());$i->next();$source[]='tail';var_dump($i->key(),$i->current());$i->rewind();var_dump(iterator_to_array($i));}
$i=new ArrayIterator([30,10,20]);$i->next();$i->asort();var_dump($i->key(),$i->current());
$i=new ArrayIterator([30,10,20]);$i->next();unset($i[0]);$i->asort();var_dump($i->key(),$i->current());
$i=new ArrayIterator([1,2,3]);$i->next();unset($i[1]);$i[1]=4;var_dump($i->key(),$i->current());
foreach([false,true] as $backed){$a=['a','b','c'];$o=new ArrayObject($a);$i=$backed?$o->getIterator():new ArrayIterator($a);$source=$backed?$o:$i;$i->next();unset($source[0]);var_dump($i->key(),$i->current());unset($source[1]);var_dump($i->key(),$i->current());$source[1]='new';$i->next();var_dump($i->key(),$i->current(),$a);}
$o=new ArrayObject(['a','b','c']);$i=$o->getIterator();$i->next();$a=['x','y','z'];$o->exchangeArray($a);unset($o[0]);var_dump($i->key(),$i->current());
foreach (['asort', 'ksort', 'natsort', 'uasort'] as $sorter) {
    $object = new ArrayObject([7, 8, 9]);
    $iterator = $object->getIterator();
    $iterator->next();
    $iterator->next();
    $object->asort();
    unset($object[0], $object[1]);
    if ($sorter === 'uasort') $object->$sorter(fn($left, $right) => $left <=> $right);
    else $object->$sorter();
    var_dump($iterator->key(), $iterator->current(), $iterator->valid());
    $object[] = 12;
    var_dump($iterator->key(), array_key_last($object->getArrayCopy()));
}
