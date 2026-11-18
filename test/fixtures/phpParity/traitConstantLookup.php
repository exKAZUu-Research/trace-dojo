<?php
trait T {
    public const X = 1;
    public static $p;
    public static function f($arg=0) { return $arg + 3; }
}
class Base {
    private const X = 2;
    protected const Y = 3;
    public static function values() {
        var_dump(constant('self::X'), constant('static::Y'), defined('static::Y'));
    }
}
class Child extends Base {
    use T {f as inheritedF;}
    protected const Y = 4;
    public static function inherited() {
        var_dump(constant('parent::Y'), defined('self::X'));
    }
}
Child::values();
Child::inherited();
function traitArg() { echo 'argument', "\n"; return 1; }
$call = T::f(...);
var_dump($call(traitArg()), call_user_func(['T', 'f'], 2), T::f(traitArg()), Child::inheritedF());
T::$p ??= 1;
T::$p += 2;
var_dump(isset(T::$p), T::$p, defined('T::X'), Child::X);
foreach ([fn() => T::X, fn() => constant('t::X'), fn() => defined('parent::Y')] as $read) {
    try { $read(); } catch (Error $e) { echo $e->getMessage(), "\n"; }
}
try { if (true) { class Broken { use Base; } } } catch (Error $e) { echo $e->getMessage(), "\n"; }

class FirstCycle { const X = self::X; }
class CycleLeft { const X = CycleRight::Y; }
class CycleRight { const Y = CycleLeft::X; }
foreach ([fn()=>FirstCycle::X, fn()=>CycleLeft::X, fn()=>CycleRight::Y, fn()=>constant('CycleLeft::X')] as $read) {
    try { $read(); } catch (Error $e) { echo $e->getMessage(), "\n"; }
}
