<?php
class PackedArgument {
    function __construct(public int $id) {}
    function __destruct() { echo "drop $this->id\n"; }
}
function replaceArgument($argument) {
    $argument = null;
    echo "replaced\n";
}
class PackedMethods {
    function __call($name, $arguments) {
        $arguments = null;
        echo "$name\n";
    }
    static function __callStatic($name, $arguments) {
        $arguments = null;
        echo "$name\n";
    }
}
replaceArgument([new PackedArgument(1)]);
(new PackedMethods)->instance(new PackedArgument(2));
PackedMethods::staticMethod(id: new PackedArgument(3));
call_user_func_array('replaceArgument', [new PackedArgument(4)]);
replaceArgument(...[new PackedArgument(5)]);
(new PackedMethods)->closureCall(...)(new PackedArgument(6));
PackedMethods::staticClosure(...)(id: new PackedArgument(7));
