<?php
class Node{public $parent;public $children=[];function __construct(public int $id){}function __destruct(){if($this->id%5000===0)echo 'free ',$this->id,"\n";}}
for($i=1;$i<=12000;$i++){$p=new Node($i);$c=new Node(-$i);$c->parent=$p;$p->children[]=$c;}
echo "loop done\n";var_dump(new stdClass);echo gc_collect_cycles(),"\n";
