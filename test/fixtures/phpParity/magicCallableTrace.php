<?php
class FallingBack {
    function __call($name, $arguments) { return (new Exception())->getTraceAsString(); }
    static function __callStatic($name, $arguments) { return (new Exception())->getTraceAsString(); }
}
echo (new FallingBack)->first(...)(21), "\n";
echo FallingBack::second(...)(34), "\n";
class ExtendingFallback extends FallingBack {}
$child = new ExtendingFallback;
echo $child->third(...)(), "\n";
echo ExtendingFallback::fourth(...)(), "\n";
echo Closure::fromCallable([$child, 'fifth'])(23), "\n";
echo Closure::fromCallable('ExtendingFallback::sixth')(45), "\n";
var_dump($child->trace(...), Closure::fromCallable([$child, 'fromTrace']));

class MagicBinding {
    function __construct(private string $label) {}
    function __call($name, $arguments) {
        echo $this->label, ':', static::class, ':', $name, ':', json_encode($arguments), "\n";
    }
    static function __callStatic($name, $arguments) { echo static::class, ':', $name, "\n"; }
}
class MagicBindingChild extends MagicBinding {
    function __call($name, $arguments) { echo 'override'; }
}
$original = new MagicBinding('original');
$receiver = new MagicBinding('receiver');
$subclass = new MagicBindingChild('subclass');
foreach ([$original->missing(...), Closure::fromCallable([$original, 'missing'])] as $callable) {
    $callable->bindTo($receiver)(1);
    Closure::bind($callable, $subclass)(2);
    try { $callable->call($receiver, value: 3); }
    catch (Throwable $error) {
        echo $error->getMessage(), "\n", $error->getTraceAsString(), "\n";
    }
}
$static = MagicBindingChild::missing(...);
$static();
$static->bindTo(null)();

class MagicReference {
    public $value = 1;
    public static $shared = 2;
    function &__call($name, $args) { return $this->value; }
    static function &__callStatic($name, $args) { return self::$shared; }
}
$object = new MagicReference;
foreach ([$object->alias(...), Closure::fromCallable([$object, 'alias'])] as $fn) {
    $alias = &$fn();
    $alias++;
}
foreach ([MagicReference::alias(...), Closure::fromCallable('MagicReference::alias')] as $fn) {
    $alias = &call_user_func_array($fn, []);
    $alias++;
}
var_dump($object->value, MagicReference::$shared);
$dynamic = 'call_user_func';
$alias = &$dynamic($fn);
$alias++;
var_dump(MagicReference::$shared);

class TemporaryMagicReference extends MagicReference {
    function __destruct() { $this->value = 9; }
}
$alias = &(new TemporaryMagicReference)->alias(...)();
var_dump($alias);

class PropertyCallbackAlias {
    public int $value;
    public static int $shared;
}
foreach (['dynamic', 'named', 'unpacked'] as $call) {
    $box = new PropertyCallbackAlias;
    $old = 3;
    $box->value = &$old;
    PropertyCallbackAlias::$shared = &$old;
    if ($call === 'dynamic') $box->value = &$dynamic($fn);
    if ($call === 'named') PropertyCallbackAlias::$shared = &call_user_func_array(callback: $fn, args: []);
    if ($call === 'unpacked') $box->value = &call_user_func(...[$fn]);
    $box->value = 9;
    var_dump($old, PropertyCallbackAlias::$shared, MagicReference::$shared);
}
