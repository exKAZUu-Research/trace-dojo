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
