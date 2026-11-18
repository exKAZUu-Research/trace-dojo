<?php
class FallingBack {
    function __call($name, $arguments) { return (new Exception())->getTraceAsString(); }
    static function __callStatic($name, $arguments) { return (new Exception())->getTraceAsString(); }
}
echo (new FallingBack)->first(...)(21), "\n";
echo FallingBack::second(...)(34), "\n";
