<?php
class N extends ArrayIterator{function next():void{parent::next();}}
class K extends ArrayIterator{function key():string|int|null{return parent::key();}}
class R extends ArrayIterator{function rewind():void{parent::rewind();}}
class V extends ArrayIterator{function valid():bool{return parent::valid();}}
foreach ([ArrayIterator::class,N::class,K::class,R::class,V::class] as $class) foreach ([true,false] as $keys) {$x=1;$a=iterator_to_array(new $class([&$x]),$keys);$x=2;var_dump($a);}
