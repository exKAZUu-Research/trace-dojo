<?php
$i = 1;
var_dump($i + $i++, $i === $i++, ($i) <=> $i++);
$text = 'a';
var_dump($text . ($text = 'b'));
$value = 1;
$alias =& $value;
var_dump($value + ($alias = 5));
$global = 1;
function changeGlobal() { global $global; $global = 4; return 3; }
var_dump($global + changeGlobal());
function replaceArray() { global $array; $array = [10, 20]; return 1; }
function replaceObject() { global $object; $object = (object)['key' => 'new']; return 'key'; }
$array = [1, 2];
$object = new stdClass;
var_dump($array[replaceArray()], $object->{replaceObject()});
$array = [];
$i = 0;
$array[$i] = $i++;
$array[$i++][$i] = $i++;
var_dump($array);
$array = [];
$i = 0;
$array[$i][$i] = $i++;
$array[$i + 1] ??= $i++;
$array[$i] ??= $i++;
var_dump($array);
$object = new stdClass;
$name = 'first';
$object->$name = ($name = 'second');
$object->$name .= ($name = 'third');
var_dump((array)$object);
$name = 'before';
$$name = ($name = 'after');
var_dump($after);
