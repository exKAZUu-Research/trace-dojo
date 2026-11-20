<?php
$iterator=new CachingIterator(new ArrayIterator([]),CachingIterator::FULL_CACHE);
$iterator->offsetSet(null,'value');
var_dump($iterator->offsetGet(null),$iterator->offsetExists(null));
$iterator->offsetUnset(null);
var_dump($iterator->getCache());
