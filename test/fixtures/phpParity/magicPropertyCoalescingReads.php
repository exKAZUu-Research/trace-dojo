<?php
class M{private $data=['x'=>1,'arr'=>['k'=>2],'nil'=>null];function __get($n){echo "get($n);";return $this->data[$n]??null;}function __set($n,$v){echo "set($n);";$this->data[$n]=$v;}}
function value($v){echo 'rhs;';return $v;}
$m=new M;$m->x??=value(3);var_dump($m->x??'default',$m->arr['k']??9,$m->missing??9,isset($m->x),empty($m->x));$m->nil??=value(4);var_dump($m->nil??9);
class T extends M{function __isset($n){echo "isset($n);";return $n!=='x';}}$t=new T;var_dump($t->x??9,$t->arr['k']??9);$t->x??=value(7);var_dump($t->x??9);
class U{public int $x;function __get($n){echo 'uget;';return 4;}}$u=new U;var_dump($u->x??9);unset($u->x);var_dump($u->x??9);
class P{private $x=1;protected $y=2;function __get($n){echo "pget($n);";return 8;}}$p=new P;var_dump($p->x??9,$p->y??9);
class R{function __get($n){echo 'rget;';return $this->$n??3;}}var_dump((new R)->x??9);
class H{public int $x{get{echo 'hook;';return 2;}}} $h=new H;var_dump($h->x??9);$h->x??=value(5);
$c=clone $u;var_dump($c->x??9);$c->x=3;var_dump($c->x??9);var_dump(empty($h->x));
class V{public int $x;function __isset($n){echo 'visset;';return true;}function __set($n,$v){echo 'vset;';$this->$n=$v;}function __get($n){echo 'vget;';return '4';}}
$v=new V;var_dump(isset($v->x),empty($v->x),$v->x??9);unset($v->x);var_dump($v->x??9);$v->x=5;var_dump($v->x);
class W{public int $x=1;function __get($n){return 'bad';}}$w=new W;unset($w->x);try{var_dump($w->x??9);}catch(Throwable $e){echo $e->getMessage();}
class WChild extends W{}$w=new WChild;unset($w->x);try{var_dump($w->x??9);}catch(Throwable $e){echo $e->getMessage();}
class Z{public $x=1;public int $y;function __unset($n){echo "unset($n);";unset($this->$n);}}$z=new Z;unset($z->x);unset($z->x);unset($z->y);unset($z->y);
