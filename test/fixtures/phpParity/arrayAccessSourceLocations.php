<?php
$a=new SplFixedArray(1);
try{$a[2]=1;}catch(Throwable $e){echo $e->getTraceAsString(),"\n";}
try{$x=$a[2];}catch(Throwable $e){echo $e->getTraceAsString(),"\n";}
try{unset($a[2]);}catch(Throwable $e){echo $e->getTraceAsString(),"\n";}
class A implements ArrayAccess{function offsetExists(mixed $k):bool{throw new Exception('exists');}function offsetGet(mixed $k):mixed{throw new Exception('get');}function offsetSet(mixed $k,mixed $v):void{throw new Exception('set');}function offsetUnset(mixed $k):void{throw new Exception('unset');}}
$a=new A;try{isset($a[1]);}catch(Throwable $e){echo $e->getTraceAsString(),"\n";}
try{$x=$a[1];}catch(Throwable $e){echo $e->getTraceAsString(),"\n";}
try{$a[1]=2;}catch(Throwable $e){echo $e->getTraceAsString(),"\n";}
try{unset($a[1]);}catch(Throwable $e){echo $e->getTraceAsString(),"\n";}
