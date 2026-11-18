<?php
function byReference(&$value) { var_dump($value); }
function useArguments(...$values) {
    try { array_pop(func_get_args()); }
    catch (Error $error) { echo $error->getMessage(), "\n"; }
    try { end(func_get_args()); }
    catch (Error $error) { echo $error->getMessage(), "\n"; }
}
useArguments(1, 2);
$text = 'example';
try { byReference(substr($text, 1)); }
catch (Error $error) { echo $error->getMessage(), "\n"; }
try { byReference(sprintf('%s', $text)); }
catch (Error $error) { echo $error->getMessage(), "\n"; }
byReference(sprintf('%.2f', 1));
byReference(explode('x', $text));
