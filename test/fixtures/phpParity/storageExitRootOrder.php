<?php
class ReleaseKey {
    function __construct(public $id) {}
    function __destruct() { echo 'key:', $this->id, ';'; }
}
class ReleaseValue {
    function __construct(private bool $stops) {}
    function __destruct() {
        if ($this->stops) { echo 'first;'; exit; }
        echo 'later;';
        throw new Exception('discard this exception');
    }
}
class ObserveReleasedStorage {
    function __construct(private $storage) {}
    function __destruct() { echo 'state:', count($this->storage), ':', $this->storage->key(), ';'; }
}
$storage = new SplObjectStorage;
$remove = new SplObjectStorage;
$storage[$first = new ReleaseKey(1)] = new ReleaseValue(true);
$storage[$second = new ReleaseKey(2)] = new ReleaseValue(false);
$storage[$third = new ReleaseKey(3)] = 3;
$remove[$first] = $remove[$second] = $remove[$third] = 0;
$observer = new ObserveReleasedStorage($storage);
$storage->next();
$storage->removeAll($remove);
echo 'never';
