<?php
function target() { echo "rhs;"; return "stdClass"; }
foreach ([null, 1, "x", [], new stdClass()] as $value) { var_dump($value instanceof (target())); }
$invalid = 123;
foreach ([null, new stdClass()] as $value) {
    try { var_dump($value instanceof ($invalid)); } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
}
