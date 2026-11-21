<?php
class Aint{public readonly int $x;}class Astring{public readonly string $x;}class Aarray{public readonly array $x;}class ANint{public readonly ?int $x;}class ANarray{public readonly ?array $x;}class Amixed{public readonly mixed $x;}
function rhs(){echo 'rhs;';return 2;}
foreach (['int','string','array','?int','?array','mixed'] as $type) {
 $class=['int'=>'Aint','string'=>'Astring','array'=>'Aarray','?int'=>'ANint','?array'=>'ANarray','mixed'=>'Amixed'][$type];
 foreach (['unset','increment','assign','coalesce'] as $op) {
  $a=new $class;
  try {if($op==='unset')unset($a->x[0]);elseif($op==='increment')$a->x[0]++;elseif($op==='assign')$a->x[]=rhs();else $a->x[0]??=rhs();echo 'ok;';}catch(Throwable $e){echo $e->getMessage(),';';}
 }
 echo "\n";
}
class Arr{public readonly array $x;function __construct(){$this->x=[1];}}
class Str{public readonly string $x;function __construct(){$this->x='foo';}}
foreach ([new Arr,new Str] as $a) {
 try {var_dump($a->x[0]??=rhs());}catch(Throwable $e){echo $e->getMessage(),"\n";}
 try {var_dump($a->x[9]??=rhs());}catch(Throwable $e){echo $e->getMessage(),"\n";}
}
