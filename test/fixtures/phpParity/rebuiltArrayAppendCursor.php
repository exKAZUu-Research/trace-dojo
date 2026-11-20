<?php
foreach (['asort','arsort','ksort','krsort'] as $sort) {
    $a=[0=>2,PHP_INT_MAX=>1]; $sort($a);
    try {$a[]=3;} catch(Throwable $e){echo $e->getMessage(),'|';}
    unset($a[PHP_INT_MAX]);$a[]=3;
    var_dump(array_key_last($a),$a[PHP_INT_MAX]);
}
