<?php
class StorageShutdownDrop {
    function __construct(public $id) {}
    function __destruct() {
        echo "drop:$this->id;\n";
        throw new Exception('stop');
    }
}
$storage = new SplObjectStorage;
$storage[new stdClass] = new StorageShutdownDrop(1);
$storage[new stdClass] = new StorageShutdownDrop(2);
echo "done;\n";
