<?php
var_dump(str_split(''), strcmp('a','z'), strncmp('a','z',1), strcasecmp('a','z'), strncasecmp('A','Z',1));
$x=1; $a=['x'=>&$x]; $b=[...$a]; $o=(object)$a; $c=(array)$o; $x=2; var_dump($b,$o->x,$c);
function f(){return [1,2];} foreach(f() as &$v){$v++;echo $v;} echo "\n";
function inc(&...$args){$args['x']++;} $n=1; inc(x:$n); var_dump($n);
class H extends SplHeap { public int $dir=1; protected function compare(mixed $a,mixed $b):int{return $this->dir*($a<=>$b);} }
$h=new H; $c=clone $h; $c->dir=-1; $c->insert(1); $c->insert(2); echo $c->top(), "\n";
echo 123456789012345.0,"\n",100000000000005.0,"\n",12345678901234.5,"\n";
var_dump(mb_strlen('あ','ISO-8859-1'),bin2hex(mb_chr(65,'UTF-16LE')));
mb_internal_encoding('ISO-8859-1'); var_dump(mb_internal_encoding(),mb_strlen('あ')); mb_internal_encoding('UTF-8');
class Typed { public int $x=1; }
$t=new Typed; $r=1; $t->x=&$r;
try{$r='hello';}catch(TypeError $e){echo $e->getMessage(),"\n";}
unset($t->x); $r='hello';var_dump($r);
try{count([1],5);}catch(ValueError $e){echo $e->getMessage(),"\n";}
