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
