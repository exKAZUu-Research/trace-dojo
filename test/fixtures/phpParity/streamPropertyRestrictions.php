<?php
foreach([STDOUT,STDERR,STDIN] as $s){
 try{$s->x=1;}catch(Throwable $e){echo $e->getMessage(),"\n";}
 try{$x=&$s->x;}catch(Throwable $e){echo $e->getMessage(),"\n";}
 try{$s->x[]=1;}catch(Throwable $e){echo $e->getMessage(),"\n";}
 try{$x=1;$s->x=&$x;}catch(Throwable $e){echo $e->getMessage(),"\n";}
 try{$s->x+=1;}catch(Throwable $e){echo $e->getMessage(),"\n";}
 unset($s->x);var_dump(isset($s->x),$s->x??'absent');
 var_dump($s->x);
 try{$s->f();}catch(Throwable $e){echo $e->getMessage(),"\n";}
}
