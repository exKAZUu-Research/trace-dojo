<?php
declare(strict_types=1);
$iterator=new CachingIterator(new ArrayIterator([]),CachingIterator::FULL_CACHE);
foreach(['offsetSet','offsetGet','offsetExists','offsetUnset'] as $method){
    try {if($method==='offsetSet')$iterator->$method(1,'value');else $iterator->$method(1);}catch(Throwable $error){echo $error->getMessage(),"\n";}
}
var_dump($iterator->getCache());
