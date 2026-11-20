<?php
class Item {
    function __construct(public $name) {}
    function __destruct() { echo "-$this->name "; }
    function __toString(): string { echo "string$this->name "; return "S"; }
}
function value($name) { return new Item($name); }
function other($name) { echo "next$name "; return true; }
if (new Item(1)) { echo "if|"; }
if (false) {} elseif (value(2)) { echo "elseif|"; }
while (new Item(3)) { echo "while|"; break; }
do { echo "do|"; } while (value(4) && false);
for ($i = 0; $i < 1 && value(5); $i++) { echo "for|"; }
value(6) && other(6); echo "and|";
value(7) || other(7); echo "or|";
echo value(8) ? other(8) : other(9), "ternary|";
var_dump(value(10) ?: other(10));
var_dump(value(11) xor other(11));
echo value(12), "next|", value(13), "end|";
if (value(14)) { var_dump(new stdClass()); }
