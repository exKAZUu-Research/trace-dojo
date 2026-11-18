<?php
error_reporting(0);
class ReattachInfo {
    function __construct(private $storage, private $object, private $label) {}
    function __destruct() {
        echo "drop:$this->label;";
        $this->storage[$this->object] = 'reattached';
        throw new Exception($this->label);
    }
}
class NativeIdentityStorage extends SplObjectStorage {}
class CallbackHashStorage extends SplObjectStorage {
    function getHash(object $object): string { return (string) $object->id; }
}
foreach ([new NativeIdentityStorage, new CallbackHashStorage] as $storage) {
    $a = (object) ['id' => 1];
    $b = (object) ['id' => 2];
    $c = (object) ['id' => 3];
    $storage[$a] = 'one';
    $storage[$b] = 'two';
    $storage[$c] = new ReattachInfo($storage, $c, 'three');
    $remove = new SplObjectStorage;
    $remove[$c] = 0;
    $remove[$a] = 0;
    $storage->next();
    try { $storage->removeAll($remove); }
    catch (Exception $error) { echo 'caught:', $error->getMessage(), ';'; }
    echo 'at:', $storage->key(), ';';
    foreach ($storage as $entry) echo $storage->getInfo(), ';';
    echo "\n";
}

class RemovedKey {
    function __construct(public $id) {}
    function __destruct() { echo 'key:', $this->id, ';'; }
}
class RemovedInfo {
    function __construct(private $name) {}
    function __destruct() { echo "info:$this->name;"; throw new Exception($this->name); }
}
foreach ([false, true] as $sourceCustom) {
    foreach ([false, true] as $keepCustom) {
        foreach ([false, true] as $keepMiddle) {
            $storage = $sourceCustom ? new CallbackHashStorage : new NativeIdentityStorage;
            $keep = $keepCustom ? new CallbackHashStorage : new NativeIdentityStorage;
            $storage[new RemovedKey(1)] = new RemovedInfo('first');
            $storage[$middle = (object) ['id' => 2]] = 'middle';
            $storage[$last = (object) ['id' => 3]] = 'last';
            if ($keepMiddle) $keep[$middle] = true;
            $storage->next();
            try { $storage->removeAllExcept($keep); }
            catch (Exception $error) { echo 'caught:', $error->getMessage(), ';'; }
            echo count($storage), ':', $storage->key(), ';';
            foreach ($storage as $key) echo $storage->getInfo(), ';';
            echo "\n";
        }
    }
}
$storage = new SplObjectStorage;
$storage[new stdClass] = new RemovedInfo('first');
$storage[new stdClass] = new RemovedInfo('second');
try { $storage->removeAllExcept(new SplObjectStorage); }
catch (Exception $error) {
    echo $error->getMessage(), '/', $error->getPrevious()->getMessage(), ':', count($storage), "\n";
}
