<?php
class A{function f(){return 1;}static function g(){return 2;}}
class B{}
function ordinary(){return 3;}
$a=new A;
foreach([A::g(...),Closure::fromCallable([A::class,'g'])] as $f){var_dump($f->bindTo($a)===null,Closure::bind($f,$a)===null);}
$f=$a->f(...);
foreach([B::class,null,stdClass::class,A::class] as $scope){var_dump($f->bindTo($a,$scope)===null,Closure::bind($f,$a,$scope)===null);}
$f=function(){return 4;};
foreach([stdClass::class,ArrayObject::class,B::class,null] as $scope){var_dump($f->bindTo(null,$scope)===null);}
$f=ordinary(...);$g=$f->bindTo($a);var_dump($g());
