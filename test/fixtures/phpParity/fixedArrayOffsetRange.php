<?php
$fixed = SplFixedArray::fromArray(['zero']);
foreach (['0', '9223372036854775807', '-9223372036854775808', '9223372036854775808', '-9223372036854775809', '01', '-0'] as $key) {
    echo $key, "\n";
    try { var_dump(isset($fixed[$key])); }
    catch (Throwable $error) { echo get_class($error), "\n"; }
    try { var_dump($fixed[$key]); }
    catch (Throwable $error) { echo get_class($error), "\n"; }
    try { $fixed[$key] = 'updated'; }
    catch (Throwable $error) { echo get_class($error), "\n"; }
}

class NamedFixedArray extends SplFixedArray {
    public $label = 'fixed';
    protected $hidden = 3;
}
$named = new NamedFixedArray(2);
$named[0] = 7;
var_dump((array) $named);

$live = new SplFixedArray(1);
set_error_handler(function () use ($live) { $live->setSize(2); $live[1] = 9; return true; });
var_dump($live[1.5]);
restore_error_handler();
