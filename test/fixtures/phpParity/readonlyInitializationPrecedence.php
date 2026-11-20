<?php
class A{public readonly int $i;public readonly string $s;public readonly array $a;}
$a=new A;
foreach(['i','s','a'] as $name){try{$a->$name[]=1;}catch(Throwable $e){echo get_class($e),':',$e->getMessage(),"\n";}try{$a->$name['k']??=1;}catch(Throwable $e){echo get_class($e),':',$e->getMessage(),"\n";}}
