<?php
class N{public $self;}
$keep=[];for($i=0;$i<12000;$i++){$a=[(int)1.5,true?1:2,...[1,2],PHP_VERSION,[1][0],'a'.'b'];$keep[]=$a;}unset($a,$keep);for($i=0;$i<12000;$i++){$n=new N;$n->self=$n;}var_dump(new stdClass);echo gc_collect_cycles(),"\n";unset($n);
$keep=[];for($i=0;$i<12000;$i++){$a=[@1];$keep[]=$a;}unset($a,$keep);for($i=0;$i<12000;$i++){$n=new N;$n->self=$n;}var_dump(new stdClass);echo gc_collect_cycles(),"\n";
