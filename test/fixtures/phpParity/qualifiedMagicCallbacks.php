<?php
class A {function __call($name,$args){echo "magic:$name|";}}
class B extends A {}
$b=new B;
foreach(['self::missing','parent::missing','A::missing'] as $method) {
    try {call_user_func([$b,$method]);}catch(Throwable $error){echo $error->getMessage(),'|';}
}
