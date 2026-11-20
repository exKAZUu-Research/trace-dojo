<?php
class CallbackValue {
    function __construct(public int $value) { echo "make $value\n"; }
    function __destruct() { echo "drop $this->value\n"; }
    function __toString(): string { return "$this->value"; }
}
$values = [1, 2];
foreach (['array_filter', 'array_all', 'array_find', 'array_walk'] as $function) {
    echo "$function\n";
    $function($values, fn($value) => new CallbackValue($value));
}
echo 'result ', preg_replace_callback('/\d/', fn($match) => new CallbackValue((int) $match[0]), '12'), "\n";
