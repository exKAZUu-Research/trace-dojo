<?php
class Name { function __toString() { echo "converted\n"; return "x"; } }
$x = 42;
var_dump(compact(new Name(), 1, [false, null, "x", [new stdClass()]]));
var_dump(substr_replace(["abcd", "abcd", "abcd"], "X", ["2x", "foo", 1.9], [1, "2x", "foo"]));
foreach ([["abcd", "X", [1], [2]], ["abcd", "X", 1, [2]]] as $args) {
    try { var_dump(substr_replace(...$args)); } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
}
$f = "min";
var_dump(min(0, "0"), $f(0, "0"), min(...[0, "0"]), call_user_func("min", 0, "0"));
class Methods { function hi() { echo "hi"; } static function bye() { echo "bye"; } }
foreach ([new Name(), 123, true, null, []] as $name) {
    try { (new Methods())->{$name}(); } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
    try { Methods::{$name}(); } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
}
