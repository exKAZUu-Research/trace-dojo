<?php
class ShutdownDrop {
    function __construct(public $id) {}
    function __destruct() {
        echo "drop:$this->id;\n";
        throw new Exception('stop');
    }
}
$parent = new stdClass;
$parent->first = new ShutdownDrop(1);
$parent->second = new ShutdownDrop(2);
echo "done;\n";
