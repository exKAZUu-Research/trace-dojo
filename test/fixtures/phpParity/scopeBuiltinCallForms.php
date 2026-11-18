<?php
function checkScopeCalls() {
    $value = 7;
    $array = ['dynamic' => 8];
    foreach (['compact' => 'compact', 'extract' => extract(...), 'get_defined_vars' => 'get_defined_vars',
        'func_get_args' => func_get_args(...), 'func_get_arg' => 'func_get_arg', 'func_num_args' => 'func_num_args'] as $name => $callable) {
        try {
            match ($name) {
                'compact' => $callable('value'),
                'extract' => $callable($array),
                'func_get_arg' => $callable(0),
                default => $callable(),
            };
        } catch (Error $error) { echo $error->getMessage(), "\n", $error->getTraceAsString(), "\n"; }
    }
    $extract = extract(...);
    try { $extract(); } catch (ArgumentCountError $error) { echo $error->getMessage(), "\n"; }
    var_dump(compact('value'), extract($array), $dynamic, func_get_args());
}
checkScopeCalls(42);

function checkForwarding($value) {
    $data = ['forwarded' => 8];
    var_dump(call_user_func('compact', 'value'), call_user_func('func_get_args'),
        call_user_func_array('func_num_args', []));
    var_dump(call_user_func('extract', $data), $forwarded);
    var_dump(array_keys(call_user_func('get_defined_vars')));
    $callback = 'compact';
    try { call_user_func($callback, 'value'); }
    catch (Error $error) { echo $error->getMessage(), "\n"; }
}
checkForwarding(42);
foreach (['func_get_args', 'func_get_arg', 'func_num_args', func_get_args(...)] as $callback) {
    try {
        if ($callback === 'func_get_arg') $callback(0);
        else $callback();
    } catch (Error $error) { echo $error->getMessage(), "\n"; }
}

class LiteralScope {
    const COUNT = 'func_num_args';
    static function countValues(...$values) { return (self::COUNT)(); }
}
function foldedScope($value) {
    var_dump(('func_' . 'num_args')(), LiteralScope::countValues(1, 2), ('com' . 'pact')('value'));
    var_dump(call_user_func('func_' . 'num_args'), call_user_func_array('func_' . 'get_args', []));
}
foldedScope(5);
$dynamicExtract = 'extract';
foreach ([[[], 99], [[], EXTR_PREFIX_ALL], [[], EXTR_PREFIX_ALL, '1 a'], [[]]] as $arguments) {
    try { $dynamicExtract(...$arguments); }
    catch (Error $error) { echo $error->getMessage(), "\n"; }
}
try { array_map('extract', [[]], [99]); }
catch (Error $error) { echo $error->getMessage(), "\n"; }
