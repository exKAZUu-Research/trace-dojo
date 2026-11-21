<?php
$value = 'before';
$array = ['control', &$value];
$found = array_find($array, function ($current, $key) use (&$value) {
    echo $current, "\n";
    if ($key === 0) return false;
    $value = 'after';
    return true;
});
var_dump($found, $array[1]);
