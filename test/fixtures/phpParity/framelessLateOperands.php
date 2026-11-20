<?php
function mutateOperand($result) {
    global $value;
    $value = 'bcd';
    return $result;
}
$value = 'abc';
var_dump(strpos($value, 'b', mutateOperand(0)));
$value = 'abc';
var_dump(strstr($value, mutateOperand('b')));
$value = 'abc';
var_dump(str_contains($value, mutateOperand('d')));
$value = 'abc';
var_dump(str_starts_with($value, mutateOperand('b')));
$value = 'abc';
var_dump(str_replace($value, mutateOperand('x'), 'abc'));
$value = 'abc';
var_dump(str_replace('b', $value, mutateOperand('b')));
$value = 'abc';
var_dump(implode($value, [mutateOperand('x'), 'y']));
$value = 'abc';
var_dump(in_array($value, ['bcd'], mutateOperand(true)));
$value = 'abc';
var_dump(preg_replace('/b/', $value, mutateOperand('b')));
$value = 'abc';
var_dump(trim($value, mutateOperand('b')));
$value = 'abc';
var_dump(join($value, [mutateOperand('x'), 'y']));
try {
    strpos([], 'a');
} catch (Throwable $error) {
    echo $error->getTraceAsString(), "\n";
}
