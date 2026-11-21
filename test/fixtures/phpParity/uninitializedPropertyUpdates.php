<?php
class A{public int $p;public string $s;public array $a;public int $d=1;public readonly int $r;function update(){return ++$this->r;}}
foreach(['post','pre','add','concat','unset','readonly'] as $op){$a=new A;try{switch($op){case 'post':$a->p++;break;case 'pre':++$a->p;break;case 'add':$a->p+=0.5;break;case 'concat':$a->s.='x';break;case 'unset':unset($a->d);$a->d++;break;case 'readonly':$a->update();}}catch(Throwable $e){echo get_class($e),':',$e->getMessage(),';';}var_dump(isset($a->p),isset($a->s),isset($a->d),isset($a->r));}
class M{public int $p=1;function __get($n){echo 'get;';return 4;}}$m=new M;unset($m->p);$m->p++;var_dump($m->p);
$a=new A;$a->a[]=1;var_dump($a->a);$a->p??=2;var_dump($a->p);
class B{public $x=1;public $y=2;}$b=new B;unset($b->x);var_dump($b,get_object_vars($b),(array)$b);$b->x=3;var_dump($b);
