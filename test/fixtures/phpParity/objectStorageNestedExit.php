<?php
class StoredKey {
    function __construct(private int $id) {}
    function __destruct() { echo 'key:', $this->id, "\n"; }
}
class ExitingLocal {
    function __destruct() {
        echo "local exit\n";
        exit;
    }
}
class StoredValue {
    function __construct(private int $id) {}
    function __destruct() {
        echo 'value:', $this->id, "\n";
        if ($this->id === 1) $locals = (object) ['first' => new ExitingLocal(), 'second' => new ExitingLocal()];
    }
}
class ObserveStorage {
    function __construct(private SplObjectStorage $storage) {}
    function __destruct() { echo 'count:', count($this->storage), "\n"; }
}
$storage = new SplObjectStorage();
$storage[new StoredKey(1)] = new StoredValue(1);
$storage[new StoredKey(2)] = new StoredValue(2);
$observer = new ObserveStorage($storage);
$storage->removeAllExcept(new SplObjectStorage());
echo "done\n";
