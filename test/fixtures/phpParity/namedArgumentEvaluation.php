<?php
function effect($label) { echo $label; return 1; }
function accepts($first, $second = 0) {}
try { accepts(unknown: effect('A'), second: effect('B')); }
catch (Error $error) { echo $error->getMessage(), "\n"; }
try { accepts(effect('C'), first: effect('D'), second: effect('E')); }
catch (Error $error) { echo $error->getMessage(), "\n"; }
class WithoutConstructor {}
try { new WithoutConstructor(missing: effect('F'), extra: effect('G')); }
catch (Error $error) { echo $error->getMessage(), "\n"; }
$builtin = 'strlen';
try { $builtin(str: 'invalid'); }
catch (Error $error) { echo $error->getTraceAsString(), "\n"; }
try { (new ArrayObject)->count(invalid: 1); }
catch (Error $error) { echo $error->getTraceAsString(), "\n"; }
class MagicArguments {
    function __call($method, $args) { var_dump($args); }
}
$callback = [new MagicArguments, 'missing'];
$callback(named: 42);

try { call_user_func('strlen', str: 'invalid'); }
catch (Error $error) { echo $error->getTraceAsString(), "\n"; }
try { call_user_func_array('strlen', ['str' => 'invalid']); }
catch (Error $error) { echo $error->getTraceAsString(), "\n"; }
try { call_user_func([new ArrayObject, 'count'], invalid: 1); }
catch (Error $error) { echo $error->getTraceAsString(), "\n"; }
