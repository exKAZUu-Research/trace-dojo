<?php
namespace Demo;
var_dump("ABC"::class, 'A'::class ?? 'no', ("A")::class, ("A"."B")::class, ("A" . 1)::class, "\\A"::class);
class Names { public string $name = ("A"."B")::class; }
function name(string $value = "ABC"::class) { echo $value, "\n"; }
name();
var_dump((new Names())->name);
$value = "A";
try { var_dump($value::class); } catch (\Throwable $error) { echo $error->getMessage(), "\n"; }

try { var_dump(("abc"[0])::class); } catch (\Throwable $error) { echo $error->getMessage(), "\n"; }

class SpecialNames {
    static function names() { return ["self"::class, "static"::class]; }
}
var_dump(SpecialNames::names());
