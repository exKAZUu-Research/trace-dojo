<?php
$value = 2;
$array = [1, &$value];
var_dump(array_reduce($array, function ($carry, $current) use (&$value) {
    if ($current === 1) $value = 3;
    return $carry . $current;
}, ''));

$value = 2;
set_error_handler(function () use (&$value) { $value = 3; });
var_dump(array_sum([[], &$value]), array_product([[], &$value]));
$value = 'stale';
var_export(array_count_values([[], &$value]));
restore_error_handler();
echo "\n";

class ChangingKey {
    public function __toString(): string {
        $GLOBALS['value'] = 'current';
        return 'first';
    }
}
$value = 'stale';
var_export(array_fill_keys([new ChangingKey(), &$value], true));
echo "\n";
$value = 'stale';
var_export(array_combine([new ChangingKey(), &$value], [1, 2]));
echo "\n";
