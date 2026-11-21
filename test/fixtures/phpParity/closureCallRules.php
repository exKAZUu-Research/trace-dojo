<?php
class Origin {
    private function hidden() {}
    protected function protectedMethod() {}
    private static function secret() {}
}
class Derived extends Origin {
    function attempt() { $this->hidden(); }
}
$obj = new Derived;
foreach ([fn() => $obj->attempt(), fn() => $obj->hidden(), fn() => $obj->protectedMethod(), fn() => Derived::secret(),
          fn() => Closure::fromCallable('missing'), fn() => Closure::fromCallable([$obj, 'hidden']),
          fn() => new Closure] as $try) {
    try { $try(); } catch (Throwable $error) { echo get_class($error), ': ', $error->getMessage(), "\n"; }
}
$closure = fn() => 1;
var_dump($closure->bindTo(null, 'MissingScope'));
try { $closure->property = 1; } catch (Error $error) { echo $error->getMessage(), "\n"; }
var_dump($closure->property, isset($closure->property));

class CallsMissing {
    function __call($name, $args) {
        throw new Exception($name);
    }
    static function __callStatic($name, $args) {
        throw new Exception($name);
    }
}
$obj = new CallsMissing;
$target = [$obj, 'missing'];
$static = 'CallsMissing::missing';
$firstClass = $obj->missing(...);
foreach ([fn() => $target(1), fn() => $static(2), fn() => call_user_func($target, 3),
          fn() => call_user_func_array($static, [4]), fn() => array_map($target, [5]), fn() => $firstClass(6)] as $try) {
    try { $try(); } catch (Throwable $error) { echo $error->getTraceAsString(), "\n"; }
}
