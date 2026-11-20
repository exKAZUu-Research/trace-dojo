<?php
function f($a, $b, $c = 1) {}
function g($a, $b, ...$rest) {}
function q($a, $b = 5, ...$rest) {}
foreach (['f', 'g', 'q'] as $function) {
    foreach ([[], [1], ['a' => 1], ['b' => 1], ['c' => 1]] as $args) {
        try { $function(...$args); }
        catch (Throwable $error) { echo $error->getMessage(), "\n"; }
    }
}
