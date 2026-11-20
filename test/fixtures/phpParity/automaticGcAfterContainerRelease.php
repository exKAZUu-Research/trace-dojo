<?php
class N{public $self;}$keep=[];for($i=0;$i<12000;$i++){$n=new N;$n->self=$n;$keep[]=$n;}unset($n,$keep);var_dump(new stdClass);echo gc_collect_cycles(),"\n";
