<?php
error_reporting(E_ALL & ~E_DEPRECATED);
class HashCallbacks extends SplObjectStorage {
    public string $label = 'default';
    public int $failAt = 0;
    public int $calls = 0;
    public mixed $hash = 'object';
    public function getHash(object $object) {
        echo $this->label, ':', count($this), ':', ++$this->calls, "\n";
        if ($this->calls === $this->failAt) throw new RuntimeException('getHash');
        return isset($object->id) ? "entry:$object->id" : $this->hash;
    }
    public function __clone() { echo 'clone:', $this->label, ':', $this->calls, "\n"; }
}
$object = new stdClass();
$storage = new HashCallbacks();
$storage[$object] = 42;
$storage->label = 'changed';
$clone = clone $storage;
var_dump(count($clone), $clone[$object]);
$other = new SplObjectStorage();
$other[$object] = 'unused';
$clone->failAt = $clone->calls + 2;
try { $clone->removeAll($other); }
catch (Throwable $error) { echo $error->getMessage(), "\n"; }
var_dump(count($clone));
var_dump($storage->removeAll($storage));
foreach ([23, null, false] as $hash) {
    $storage->hash = $hash;
    var_dump($storage->getHash($object));
    foreach (['offsetSet', 'offsetExists', 'offsetUnset'] as $method) {
        try { $storage->$method($object); }
        catch (TypeError $error) { echo $error->getMessage(), "\n"; }
    }
    var_dump(count($storage));
}

foreach ([false, true] as $same) {
    for ($callback = 1; $callback <= ($same ? 3 : 4); $callback++) {
        $target = new HashCallbacks();
        $other = $same ? $target : new SplObjectStorage();
        foreach ([1, 2, 3] as $value) {
            $entry = (object)['id' => $value];
            $target[$entry] = $value;
            if (!$same) $other[$entry] = $value;
        }
        $target->next();
        $target->failAt = $target->calls + $callback;
        try { $target->removeAll($other); }
        catch (RuntimeException) { echo "caught\n"; }
        var_dump(count($target), $target->key(), $target->getInfo());
    }
}

class FailingClone extends SplObjectStorage {
    public string $label = 'default';
    public bool $fail = true;
    public function __destruct() { echo 'drop:', $this->label, "\n"; }
    public function __clone() { echo "unexpected clone hook\n"; }
    public function getHash(object $object): string {
        if ($this->fail) {
            $class = $object->kind;
            throw new $class('hash failed');
        }
        return 'stable';
    }
}
foreach ([Exception::class, Error::class] as $kind) {
    $source = new FailingClone;
    $source->label = $kind;
    $source->fail = false;
    $source[(object)['kind' => $kind]] = 1;
    try { $copy = clone $source; }
    catch (Throwable $error) { echo 'caught:', get_class($error), "\n"; }
    unset($source);
}
