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
