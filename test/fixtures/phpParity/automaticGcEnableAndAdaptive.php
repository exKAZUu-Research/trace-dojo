<?php
class N{public $self;}gc_disable();for($i=0;$i<12000;$i++){$n=new N;$n->self=$n;}gc_enable();$n=new N;$n->self=$n;var_dump(new stdClass);echo gc_collect_cycles(),"\n";unset($n);
function touchValue($v){}$keep=[];for($i=0;$i<17000;$i++){$n=new N;$n->self=$n;$keep[]=$n;touchValue($n);}unset($keep,$n);for($i=0;$i<4000;$i++){$n=new N;$n->self=$n;}var_dump(new stdClass);echo gc_collect_cycles(),"\n";
