<?php
namespace Scope;
class Base {
    public static $count = 9;
    const NAME = \self::class;
    public $label = \self::class;
    function inspect($name = \self::class) {
        var_dump($name, \self::class, \static::class, namespace\self::class);
    }
}
class Child extends Base {
    function inspectParent() { var_dump(\parent::class); }
    static function value() { return namespace\self::$count; }
    function relatives(?namespace\self $self, namespace\parent $parent): namespace\self {
        var_dump(new namespace\self, new namespace\parent, new namespace\static);
        var_dump($self instanceof namespace\self, $parent instanceof namespace\parent, namespace\static::value());
        return $self;
    }
}
$c = new Child;
var_dump(Base::NAME, $c->label);
$c->inspect();
$c->inspectParent();
try { echo \self::class; } catch (\Throwable $error) { echo $error->getMessage(), "\n"; }
$c->relatives($c, new Base);
try { \Closure::bind(fn()=>\parent::class, null, Base::class)(); }
catch (\Throwable $error) { echo $error->getMessage(), "\n"; }

const CONSTANT_NAME = 'SAMPLE';
function makeConstantName() { return 'SAMPLE'; }
class DynamicBase { const SAMPLE = 'base'; }
class DynamicClass extends DynamicBase {
    const SAMPLE = 'child';
    function fetch($name) {
        return [namespace\self::{$name}, namespace\parent::{$name}, namespace\static::{$name},
            namespace\self::{CONSTANT_NAME}, namespace\self::{makeConstantName()}, namespace\self::{"$name"}];
    }
}
var_dump((new DynamicClass)->fetch('SAMPLE'));
try { $name = 'SAMPLE'; namespace\self::{$name}; }
catch (\Throwable $e) { echo $e->getMessage(),"\n"; }
