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

class ClosureScope {
    public int $value = 7;
    public function instanceClosures() {
        return [function () {return $this->value;}, fn() => isset($this), function() {return 1;}];
    }
}
$outer = new ClosureScope;
foreach ($outer->instanceClosures() as $closure) {
    var_dump($closure->bindTo(null) === null, Closure::bind($closure, null, ClosureScope::class) === null);
    $bound = $closure->bindTo(new ClosureScope);
    var_dump($bound());
}
$unbound = fn() => isset($this);
var_dump($unbound->bindTo(null) === null, $unbound());
