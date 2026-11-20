<?php
$value = 2;
$array = [PHP_INT_MAX => 1];
try { $array[] =& $value; echo "continued"; } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
unset($array[PHP_INT_MAX]);
$array[] =& $value;
var_dump($array);
unset($array[PHP_INT_MAX]);
$array[] = 3;
var_dump($array);
var_dump(array_pop($array));
$array[] = 4;
var_dump($array);
$array = [0 => 1, PHP_INT_MAX => 2];
unset($array[PHP_INT_MAX]);
$array[] = 3;
var_dump($array);
