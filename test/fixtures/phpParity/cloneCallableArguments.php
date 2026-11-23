<?php
class Item{public int $x=1;function __clone(){echo 'cloned',"\n";}}
$a=new Item;
foreach([clone(object:$a),clone(...[$a]),clone($a,withProperties:['x'=>2]),clone(object:$a,withProperties:['x'=>3])] as $b)var_dump($b->x);
$f=clone(...);var_dump($f($a,['x'=>4])->x);$g='clone';var_dump($g($a)->x);
foreach([fn()=>clone(),fn()=>clone(object:3),fn()=>clone($a,3),fn()=>clone($a,unknown:1)] as $f){try{$f();}catch(Throwable $e){echo get_class($e),': ',$e->getMessage(),"\n";}}
