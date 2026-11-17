<?php
function inc(&$x) {$x++;}
$o=(object)['a'=>[1]];inc(...$o->a);$a=[[1]];inc(...$a[0]);
class S {public static $a=[1]; public static int $i; public static ?int $n;}
inc(...S::$a);$name='v';$v=[1];inc(...$$name);var_dump($o->a,$a,S::$a,$v);inc(...$v);var_dump($v);
$x=1;$a=['k'=>&$x];$b=[...$a,'k'=>2];var_dump($x,$a,$b);
unset($x);$b=[...$a];$b['k']=3;var_dump($a,$b);$c=array_merge($a);$c['k']=4;var_dump($a,$c);
$x=1;$a=[&$x];$filter=array_filter($a);$unique=array_unique($a);$chunk=array_chunk($a,1);$x=9;var_dump($filter,$unique,$chunk);
class P {protected $p=1;private $q=2;}
$p=new P;array_walk($p,function(&$v,$k){echo bin2hex($k),':';$v++;});echo "\n";var_dump((array)$p);
class T {public string $x='01';public int $y=1;}
$t=new T;try {$t->y=&$t->x;}catch(Throwable $e){echo "caught\n";}var_dump($t->x,$t->y);
try {$r=&S::$i;}catch(Throwable $e){echo $e->getMessage(),"\n";}$r=&S::$n;var_dump($r);$r=8;var_dump(S::$n);
function &source() {global $v;return $v;}
foreach(source() as &$item){$item++;}unset($item);var_dump($v);
class Magic {function __set($n,$v){echo 'set';}function __get($n){echo 'get';return 1;}}
$m=new Magic;$x=1;try{$m->x=&$x;}catch(Throwable $e){echo ':',$e->getMessage(),"\n";}
class Getter {public $values=[1,2];function &__get($name){echo 'get ';return $this->values;}}
$g=new Getter;unset($g->x[0]);var_dump($g->values);
class Destroy {function __destruct(){echo 'destroy ';}}
$x=new Destroy;echo settype($x,'bool'),'after',"\n";
