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

echo end(call_user_func('explode', ',', 'a,b')), "\n";
byReference(call_user_func_array('strlen', ['a']));
byReference(call_user_func(fn () => 1));
foreach ([fn () => byReference(is_null($text)), fn () => byReference(is_int(1)),
    fn () => byReference(is_array([])), fn () => byReference(gettype($text)),
    fn () => byReference(chr(65)), fn () => byReference(ord('a')),
    fn () => byReference(defined('VALUE'))] as $check) {
    try { $check(); }
    catch (Error $error) { echo $error->getMessage(), "\n"; }
}
$code = 65;
byReference(chr($code));
byReference(ord('abc'));
$callback = function (&$value) {};
try { $callback(strlen('x')); }
catch (Error $error) { echo $error->getMessage(), "\n"; }
$arrow = fn (&$value) => 1;
try { $arrow(strlen('x')); }
catch (Error $error) { echo $error->getMessage(), "\n"; }
class ClosureOwner { function method() { return function (&$value) {}; } }
try { (new ClosureOwner)->method()(strlen('x')); }
catch (Error $error) { echo $error->getMessage(), "\n"; }

function variadicRef($first, &...$values) {}
class MethodRef { function variadic(&...$values) {} }
$closureRef = fn (&...$values) => 1;
foreach ([fn () => variadicRef(1, 2), fn () => (new MethodRef)->variadic(strlen('x')),
    fn () => $closureRef(1, 2), fn () => variadicRef(first: 1, extra: 2)] as $check) {
    try { $check(); }
    catch (Error $error) { echo $error->getMessage(), "\n"; }
}
