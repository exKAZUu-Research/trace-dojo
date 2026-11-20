<?php
class A {function hi(){echo "A;";}}
class B extends A {function hi(){echo "B;";} function run(){foreach(['hi','parent::hi','self::hi','static::hi','A::hi','B::hi','stdClass::hi','Missing::hi'] as $m){echo "$m|"; foreach(['direct','callback','check'] as $mode) {echo "$mode:";try{$cb=[$this,$m];if($mode==='direct')$cb();elseif($mode==='callback')call_user_func($cb);else var_dump(is_callable($cb));}catch(Throwable $e){echo $e->getMessage(),";";}}echo "\n";}}}
(new B)->run();
