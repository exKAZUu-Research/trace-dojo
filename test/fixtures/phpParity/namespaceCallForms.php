<?php
namespace Lesson;
const UPPER = 1;
const
    UPPER = 2;
function forwards($value) {
    var_dump('func_num_args'(), ('func_num_args')(), ("\\func_num_args")());
    var_dump(\call_user_func('compact', 'value'), \call_user_func_array('compact', ['value']));
    foreach ([
        fn () => call_user_func('compact', 'value'),
        fn () => call_user_func_array('func_get_args', []),
        fn () => \call_user_func('\\compact', 'value'),
    ] as $call) {
        try { $call(); }
        catch (\Throwable $error) { echo $error->getMessage(), "\n", $error->getTraceAsString(), "\n"; }
    }
    $dynamic = 'func_get_arg';
    foreach ([-1, 0, 5] as $index) {
        try { $dynamic($index); }
        catch (\Throwable $error) { echo $error->getMessage(), "\n"; }
    }
}
forwards(42);
$dynamic = 'func_get_arg';
try { $dynamic(-1); }
catch (\Throwable $error) { echo $error->getMessage(), "\n"; }
