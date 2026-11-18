<?php
namespace Scope;
class Base {
    const NAME = \self::class;
    public $label = \self::class;
    function inspect($name = \self::class) {
        var_dump($name, \self::class, \static::class, namespace\self::class);
    }
}
class Child extends Base {
    function inspectParent() { var_dump(\parent::class); }
}
$c = new Child;
var_dump(Base::NAME, $c->label);
$c->inspect();
$c->inspectParent();
try { echo \self::class; } catch (\Throwable $error) { echo $error->getMessage(), "\n"; }
