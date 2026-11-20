<?php
class StringArgument {
    function __construct(public int $id) {}
    function __toString() { echo "convert $this->id\n"; return 'converted'; }
    function __destruct() { echo "drop $this->id\n"; }
}
function input_arg($id) { return new StringArgument($id); }
function receive(string $text) { echo "receive $text\n"; }
function receive_ref(string &$text) { echo "receive $text by reference\n"; }
function many(string ...$texts) { echo count($texts), " arguments\n"; }
class Wrapper {
    function __construct(public string $text) { echo "new wrapper\n"; }
}
receive(input_arg(1));
var_dump(new stdClass());
$referenced = input_arg(2);
receive_ref($referenced);
many(input_arg(3), secondary: input_arg(4));
new Wrapper(input_arg(5));
$hold = input_arg(6);
call_user_func('receive', $hold);
echo "after held call\n";
unset($hold);
