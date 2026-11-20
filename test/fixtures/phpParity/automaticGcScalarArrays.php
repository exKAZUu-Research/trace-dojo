<?php
class N{public $self;}
$keep=[];for($i=0;$i<12000;$i++){$a=[$i];$keep[]=$a;}unset($keep,$a);for($i=0;$i<12000;$i++){$n=new N;$n->self=$n;}var_dump(new stdClass);echo gc_collect_cycles(),"\n";unset($n);
$keep=[];for($i=0;$i<12000;$i++){$a=[1+2,[3]];$keep[]=$a;}unset($keep,$a);for($i=0;$i<12000;$i++){$n=new N;$n->self=$n;}var_dump(new stdClass);echo gc_collect_cycles(),"\n";
