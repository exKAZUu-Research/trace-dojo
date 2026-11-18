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

class ShutdownValue {
    public $child;
    function __construct(public $name) {}
    function __destruct() { echo $this->name, "\n"; }
}
static $unbound = new ShutdownValue('unbound static');
$unbound->child = new ShutdownValue('static child');
$global = new ShutdownValue('global');
unset($unbound);
echo "end\n";
