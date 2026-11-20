<?php
class CycleTail {public $child;function __construct($child=null){$this->child=$child;}function __destruct(){echo 'tail;';}}
$a=[];$a['self']=&$a;$a['child']=new CycleTail;unset($a);echo 'before;';var_dump(gc_collect_cycles(),gc_collect_cycles());
$a=[];$a['self']=&$a;$a['child']=new CycleTail(new stdClass);unset($a);echo 'before;';var_dump(gc_collect_cycles(),gc_collect_cycles());
class CycleRescue {public $array;function __destruct(){global $saved;$saved=$this;echo 'rescue;';}}
$a=[];$a['self']=&$a;$o=new CycleRescue;$o->array=&$a;$a['o']=$o;unset($a,$o);var_dump(gc_collect_cycles(),isset($saved));unset($saved);var_dump(gc_collect_cycles(),gc_collect_cycles());
