<?php
function change(&$value) { $value += 1; }
$name = 'tracked';
$GLOBALS[$name] = 4;
change($GLOBALS[$name]);
$copy = $GLOBALS;
$copy[$name] = 9;
var_dump($tracked, $GLOBALS[$name], $copy[$name]);
$key = 'GLOBALS';
$$key = 12;
var_dump(is_array($GLOBALS), $$key, $GLOBALS['GLOBALS']);
try { change($GLOBALS); } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
try { $GLOBALS->property = 5; } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
unset($GLOBALS[$name]);
var_dump(isset($tracked));

$ordinary = 'before';
$globalValue = 1;
$alias = &$globalValue;
$copy = $GLOBALS;
$ordinary = 'after';
$globalValue = 2;
var_dump($copy['ordinary'], $copy['globalValue'], $copy['alias']);
$copy['alias'] = 3;
var_dump($globalValue, $alias);
