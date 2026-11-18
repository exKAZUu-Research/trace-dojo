<?php
class enum {}
const enum = 5;
function enum(enum $value): ?enum { return $value; }
class TypedEnumProperty { public ?enum $value; }
$value = new enum;
var_dump(enum, $value === enum($value), enum::class);
