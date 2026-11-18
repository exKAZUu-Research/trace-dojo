<?php
function makeValue() {
    echo 'initialized', "\n";
    return 'a';
}
for ($i = 0; $i < 3; $i++) {
    static $text = makeValue();
    echo $text, "\n";
    $text .= 'b';
    if ($i === 1) unset($text);
}
class Held {
    function __destruct() { echo "destroyed\n"; }
}
$i = 0;
start:
static $value = new Held;
if ($i++ === 0) {
    unset($value);
    echo "unbound\n";
    goto start;
}
var_dump($value instanceof Held);
