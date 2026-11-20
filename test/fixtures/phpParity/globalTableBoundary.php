<?php
function change(&$value) { $value += 1; }
$name = 'tracked';
$GLOBALS[$name] = 4;
change($GLOBALS[$name]);
var_dump($tracked, $GLOBALS[$name]);
$key = 'GLOBALS';
$$key = 12;
var_dump($$key, $GLOBALS['GLOBALS']);
unset($GLOBALS[$name]);
var_dump(isset($tracked));
