<?php
foreach (['ArrayObject','ArrayIterator'] as $class) foreach ([['a'=>4,'b'=>3,'c'=>2,'d'=>1],['d','c','b','a']] as $values) foreach (['natsort','ksort','asort'] as $sort) {
 $s=new $class($values);$i=$s instanceof ArrayObject?$s->getIterator():$s;$i->next();$key=$i->key();unset($s[$key]);$s->$sort();var_dump($i->key(),$i->current());
}
foreach (['ArrayObject','ArrayIterator'] as $class) foreach (['ksort','asort','natsort'] as $sort) {
 $s=new $class([1,2]);unset($s[0]);$i=$s instanceof ArrayObject?$s->getIterator():$s;$i->rewind();$s->$sort();var_dump($i->key(),$i->current());
}
