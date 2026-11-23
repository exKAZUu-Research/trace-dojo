<?php
$s='ok';$name='s';echo "{${'s'}} {${$name}}\n";
class Hooks {public $a=1;public int $v {get {echo 'get ';return 7;}}public $b=2;public int $u {get => 8;}}
var_dump(get_object_vars(new Hooks));
class Untyped {public $s {set($v){echo $v;}}}
$u=new Untyped;$u->s=5;
echo http_build_query(['a'=>1,'b'=>2],arg_separator:''),"\n";
class Wide {public int $value {set(int|string $value){echo $value;}}}
$w=new Wide;$w->value=6;
class Base{}class Child extends Base{}class ObjectHook {public Child $value {set(Base $value){echo get_class($value);}}}
$h=new ObjectHook;$h->value=new Child;
