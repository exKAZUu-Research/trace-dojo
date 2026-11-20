<?php
$a=[];$a['self']=&$a;var_dump(gc_collect_cycles());unset($a);var_dump(gc_collect_cycles(),gc_collect_cycles());
$a=[];$b=[];$a['b']=&$b;$b['a']=&$a;unset($a,$b);var_dump(gc_collect_cycles(),gc_collect_cycles());
$a=[];$a['self']=&$a;$a['child']=[[1]];unset($a);var_dump(gc_collect_cycles());
$a=[];$a['self']=&$a;$a['child']=[new stdClass];unset($a);var_dump(gc_collect_cycles());
class Holder{public $a;}$h=new Holder;$h->a=[];$h->a['self']=&$h->a;unset($h);var_dump(gc_collect_cycles());
$a=[];$a['self']=&$a;$other=&$a;unset($a);var_dump(gc_collect_cycles());unset($other);var_dump(gc_collect_cycles());
$a=[];$a['self']=&$a;unset($a['self']);unset($a);var_dump(gc_collect_cycles());
