<?php
foreach ([0, 2147483647, 2147483648, PHP_INT_MAX] as $depth) {
    foreach (['json_decode', 'json_validate'] as $function) {
        try { var_dump($function('[]', depth: $depth)); }
        catch (ValueError $error) { echo $error->getMessage(), "\n"; }
    }
}
var_dump(json_decode('', depth: PHP_INT_MAX), json_last_error());
var_dump(json_validate('', depth: PHP_INT_MAX), json_last_error());
try { json_validate('', depth: PHP_INT_MAX, flags: 2); }
catch (ValueError $error) { echo $error->getMessage(), "\n"; }
