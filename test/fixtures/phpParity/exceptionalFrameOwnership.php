<?php
function f(&...$x){$x['foo']=4;throw new Exception('call');}
$a=[];try{f(foo:$a[]);}catch(Throwable $e){echo $e->getMessage(),';';}$b=$a;$a[0]=5;var_dump($b);
class A{static function f(&...$x){$x['foo']=4;throw new Exception('method');}}
$a=[];try{A::f(foo:$a[]);}catch(Throwable $e){echo $e->getMessage(),';';}$b=$a;$a[0]=5;var_dump($b);
function escape(&...$x){$GLOBALS['saved']=$x;throw new Exception('escape');}
$a=[1];try{escape($a[0]);}catch(Throwable $e){}$saved[0]=2;var_dump($a);unset($saved);$b=$a;$a[0]=3;var_dump($b);
class D{function __destruct(){echo 'destroy;';throw new Exception('cleanup');}}
function fail(){ $d=new D;throw new Exception('body');}
try{fail();}catch(Throwable $e){echo $e->getMessage(),':',$e->getPrevious()?->getMessage(),"\n";}
class E{function __destruct(){echo 'argument-destroy;';}}
function typed(int $a){}
try{typed(new E);}catch(Throwable $e){echo 'caught;';}
function typedRefs(int &...$args){}$a=[1,'bad'];try{typedRefs(...$a);}catch(Throwable $e){echo get_class($e),"\n";}$copy=$a;$a[0]=2;var_dump($copy);
function namedTypedRefs(int &...$args){}$a=['good'=>1,'bad'=>'bad'];try{namedTypedRefs(...$a);}catch(Throwable $e){echo get_class($e),"\n";}$copy=$a;$a['good']=2;var_dump($copy);
