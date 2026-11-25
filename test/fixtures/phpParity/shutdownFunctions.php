<?php
class D { function __destruct() { echo "destruct level ", ob_get_level(), "\n"; } }
$d = new D;
set_exception_handler(function ($e) { echo "handler ", $e->getMessage(), "\n"; });
ob_start(fn($s) => "[" . $s . "]");
register_shutdown_function(function ($a, $b) {
    echo "shutdown $a $b level=", ob_get_level(), "\n";
    register_shutdown_function(fn() => print("nested\n"));
}, 1, 2);
register_shutdown_function('printf', "%s\n", "via printf");
register_shutdown_function(function () { throw new Exception("thrown in shutdown"); });
register_shutdown_function(function () { echo "after the exception\n"; exit; });
register_shutdown_function(function () { echo "never\n"; });
echo "main\n";
