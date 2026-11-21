<?php
function takes(callable $c) { return $c(); }
class W { static function s() { return "s"; } function i() { return "i"; } }
echo spl_object_id(new stdClass), "\n";
$x = new stdClass;
try { takes('W::i'); } catch (Error $e) { echo spl_object_id($e), "\n"; }
echo spl_object_id(new stdClass), "\n";
