<?php
function captureOperandError($operation) {
    try { var_dump($operation()); } catch (TypeError $error) { echo $error->getMessage(), "\n"; }
}
function rightOperand() { echo 'right;'; return new stdClass; }
function leftOperand() { echo 'left;'; return []; }
$array = [];
$value = 4;
foreach ([
    fn() => 2 * $array,
    fn() => [1] * $value,
    fn() => (array)$value * $value,
    fn() => 2 * new stdClass,
    fn() => 2 * [],
    fn() => leftOperand() * rightOperand(),
    fn() => 2 & $array,
    fn() => (array)$value | $value,
    fn() => (array)$value ^ rightOperand(),
    fn() => 2 - $array,
    fn() => 2 + $array,
] as $operation) captureOperandError($operation);
