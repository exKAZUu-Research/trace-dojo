<?php
function class_name() { echo "class evaluated\n"; return stdClass::class; }
echo "begin\n";
var_dump((!NAN) instanceof (class_name()));
try { var_dump((!NAN)::class); } catch (Error $e) { echo $e->getMessage(), "\n"; }
var_dump((NAN && true) instanceof (class_name()));
var_dump((NAN or false) instanceof (class_name()));
var_dump((true && NAN) instanceof (class_name()));
var_dump(false && (NAN && true));
$value = true;
var_dump(($value && NAN) instanceof (class_name()));
var_dump(NAN == true, NAN == false, NAN == null, NAN <=> false, in_array(true, [NAN]));
