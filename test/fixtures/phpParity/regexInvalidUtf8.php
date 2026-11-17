<?php
$s = "\xff";
var_dump(preg_split('/a/u', $s));
var_dump(preg_replace('/a/u', 'x', $s));
var_dump(preg_replace_callback('/a/u', fn($m) => 'x', $s));
var_dump(preg_replace_callback_array(['/a/u' => fn($m) => 'x'], $s));
var_dump(preg_last_error());
