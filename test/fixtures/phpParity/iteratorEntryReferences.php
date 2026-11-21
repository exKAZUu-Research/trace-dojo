<?php
foreach([true,false] as $keys){foreach(['array','ArrayIterator','ArrayObject'] as $kind){$x=1;$a=['k'=>&$x];$input=$kind==='array'?$a:new $kind($a);$b=iterator_to_array($input,$keys);$x=2;var_dump($b);}}
foreach([true,false] as $keys){$x=1;$a=[&$x];$b=iterator_to_array($a,$keys);unset($x);$a[0]=2;var_dump($b);}
foreach([true,false] as $keys){$x=1;$a=[&$x];$b=iterator_to_array(new ArrayIterator($a),$keys);unset($x);$a[0]=2;var_dump($b);}
class I implements Iterator {public $x=1;private $valid=true;function rewind():void{$this->valid=true;}function valid():bool{return $this->valid;}function &current():mixed{return $this->x;}function key():mixed{return 'k';}function next():void{$this->valid=false;}}
$i=new I;$a=iterator_to_array($i);$i->x=2;var_dump($a);
