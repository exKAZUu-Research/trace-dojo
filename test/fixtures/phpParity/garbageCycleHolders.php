<?php
class D {public $o;public $p;function __construct(public $n){}function __destruct(){echo "d{$this->n} ";}}
$x=new D('parent');$child=new D('child');$x->o=$x;$x->p=$child;unset($x);echo 'before;';unset($child);echo 'after;';$other=new D('other');var_dump(spl_object_id($other));echo gc_collect_cycles(),"\n";unset($other);
$x=new D(1);$x->o=$x;$x->p=new D(2);unset($x);echo gc_collect_cycles(),"\n";
class P {public $o;public $p;}
$x=new P;$x->o=$x;$x->p=new D(4);unset($x);echo gc_collect_cycles(),"\n";
$x=new D(5);$x->o=$x;$x->p=[new D(6)];unset($x);echo gc_collect_cycles(),"\n";
$x=new P;$x->o=$x;$x->p=[new D(7)];unset($x);echo gc_collect_cycles(),"\n";
