<?php
class enum {
    public static int $field = 3;
    const VALUE = 5;
    public static function mark(): void { echo "class method\n"; }
}
const enum = 5;
function enum(enum $value): ?enum { return $value; }
class TypedEnumProperty { public ?enum $value; }
$value = new enum;
var_dump(enum, $value === enum($value), enum::class);

goto EnUm;
echo "skipped\n";
EnUm:
Enum::mark();
enum::$field += 1;
enum::VALUE;
enum($value);
var_dump(enum::$field);
