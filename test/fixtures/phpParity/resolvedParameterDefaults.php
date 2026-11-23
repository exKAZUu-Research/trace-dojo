<?php
set_error_handler(function ($level, $message) { echo "$message\n"; }, E_DEPRECATED);
function flags($v = E_STRICT + 1) { echo "$v\n"; }
class FlagClass { function values($v = [E_STRICT]) { $v[] = 18; echo count($v), "\n"; } }
flags(18);
flags();
flags();
$object = new FlagClass();
$object->values();
$object->values();
echo E_STRICT, "\n";
function fresh($v = new stdClass()) { return $v; }
var_dump(fresh() === fresh());
