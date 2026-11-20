<?php
class A { public ?int $a=null; }
$o=new A;$r=&$o->a;
try{$r[]=1;}catch(Throwable $e){echo $e->getMessage(),"\n";}
try{$r['k']['m']=1;}catch(Throwable $e){echo $e->getMessage(),"\n";}
$arr=[&$o->a];try{$arr[0][]=1;}catch(Throwable $e){echo $e->getMessage(),"\n";}
function appendTo(&$z){$z[]=3;}
try{appendTo($o->a);}catch(Throwable $e){echo $e->getMessage(),"\n";}
try{foreach($o as &$v)$v[]=1;}catch(Throwable $e){echo $e->getMessage(),"\n";}
try{$o->a[]=1;}catch(Throwable $e){echo $e->getMessage(),"\n";}
class B {public ?array $a=null;}
$b=new B;$r=&$b->a;$r[]=1;var_dump($b->a);
