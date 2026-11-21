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
function nestedReturns(): int {
    try { return 1; }
    finally {
        try {
            try { return 2; }
            finally { throw new Exception('canceled'); }
        } catch (Exception $error) {}
    }
}
var_dump(nestedReturns());
function &nestedReference() {
    global $value;
    try { return $value; }
    finally {
        try {
            try { $other = 'discarded'; return $other; }
            finally { throw new Exception('canceled'); }
        } catch (Exception $error) { $value = 'kept'; }
    }
}
$ref = &nestedReference();
var_dump($ref);
$ref = 'live';
var_dump($value);
