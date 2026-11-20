<?php
gc_disable();class N{public $self;}
for($i=0;$i<12000;$i++){$n=new N;$n->self=$n;}
echo spl_object_id(new stdClass),':',gc_collect_cycles(),"\n";gc_enable();
