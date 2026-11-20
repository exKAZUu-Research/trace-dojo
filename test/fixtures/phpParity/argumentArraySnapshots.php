<?php
$array = [];
array_push($array, 2, 1);
var_dump($array, sort($array), $array);
$alias =& $array;
var_dump($array, array_pop($alias), $array);
function observe($before, $other, $after) { var_dump($before, $other, $after); }
observe($array, array_unshift($array, 0), $array);
