<?php
class Destructible {
    function __destruct() {}
}
$objects = [];
for ($i = 0; $i < 3000; $i++) $objects[] = new Destructible;
extract($objects, EXTR_PREFIX_ALL, 'obj');
unset($objects);
echo "ok\n";

class Handler {
    function __invoke(...$args) {}
    function __destruct() { echo "handler\n"; }
}
class ObserveHandler {
    function __destruct() {
        global $handler;
        echo isset($handler) ? "present\n" : "absent\n";
    }
}
$observer = new ObserveHandler;
$handler = new Handler;
set_error_handler($handler);
