<?php
$array = [1];
$array[] = $array;
$array[1][] = 2;
var_dump($array);

$nested = [1];
$nested['outer']['inner'] = $nested;
var_dump($nested);

$indexed = [1, 2];
$indexed[0] = $indexed;
var_dump($indexed);

$value = [1];
$alias =& $value;
$alias[] = $alias;
$alias[] = $value;
var_dump($alias);

function copyDuringAppend($array) {
    $array[] = $array;
    return $array;
}
var_dump(copyDuringAppend([1]));

$array = [1];
$array[] = $array[0] === 1 ? $array : null;
var_dump($array);
