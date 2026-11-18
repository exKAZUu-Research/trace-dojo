<?php
$value = 1;
function &byReference() {
    global $value;
    try { return $value; }
    finally { $value = 3; }
}
var_dump(byReference(), $value);
$ref = &byReference();
$ref = 5;
var_dump($value);
function &typedReference(): int {
    global $value;
    try { return $value; }
    finally { $value = 'changed'; }
}
try { typedReference(); }
catch (TypeError $error) { echo $error->getMessage(), "\n"; }
var_dump($value);
function &replaceReference() {
    global $value;
    try { return $value; }
    finally { $local = 'replacement'; return $local; }
}
$replacement = &replaceReference();
var_dump($replacement, $value);
