<?php
class ExitLocal {
    function __construct(public $label) {}
    function __destruct() { echo $this->label, "\n"; }
}
class ExitsInConstructor {
    function __construct() { exit; }
    function __destruct() { echo "unexpected constructor destructor\n"; }
}
function outer($argument) {
    $local = new ExitLocal('local');
    array_map(function ($value) {
        $callback = new ExitLocal('callback local');
        try { new ExitsInConstructor; }
        finally { echo "unexpected finally\n"; }
    }, [1]);
}
$global = new ExitLocal('global');
outer(new ExitLocal('argument'));
