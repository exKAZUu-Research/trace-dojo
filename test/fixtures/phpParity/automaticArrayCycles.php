<?php
for($i=0;$i<20000;$i++){$a=[];$a[]=&$a;unset($a);}echo gc_collect_cycles(),"\n";
