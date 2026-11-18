<?php
class CleanupInfo {
    function __construct(private string $mode) {}
    function __destruct() {
        echo $this->mode, ';';
        if ($this->mode === 'exit') exit(7);
        if ($this->mode === 'throw') throw new Exception('cleanup');
    }
}
foreach (['removeAll', 'removeAllExcept'] as $operation) {
    foreach ([['exit', 'throw', 'normal'], ['throw', 'exit', 'throw'], ['exit', 'exit', 'throw']] as $modes) {
        $storage = new SplObjectStorage();
        $other = new SplObjectStorage();
        foreach ($modes as $mode) {
            $key = new stdClass();
            $storage[$key] = new CleanupInfo($mode);
            if ($operation === 'removeAll') $other[$key] = 0;
        }
        try { $storage->$operation($other); }
        catch (Throwable $error) {
            echo $error->getMessage(), ';', count($storage), ';';
            var_dump($error->getPrevious());
        }
    }
}
echo "done\n";

class CustomCleanupStorage extends SplObjectStorage {
    function getHash($object): string { return (string) spl_object_id($object); }
}
class NestedCleanupInfo {
    function __destruct() {
        $locals = [new CleanupInfo('exit'), new CleanupInfo('throw')];
    }
}
foreach (['removeAll', 'removeAllExcept'] as $operation) {
    $storage = new CustomCleanupStorage();
    $other = new SplObjectStorage();
    $key = new stdClass();
    $storage[$key] = new NestedCleanupInfo();
    if ($operation === 'removeAll') $other[$key] = 0;
    try { $storage->$operation($other); }
    catch (Throwable $error) { echo $error->getMessage(), ';', count($storage), "\n"; }
}

class HashCleanupStorage extends SplObjectStorage {
    public string $mode = '';
    function getHash($object): string {
        if ($this->mode === 'body') throw new Exception('body');
        if ($this->mode === 'cleanup') $locals = [new CleanupInfo('exit'), new CleanupInfo('throw')];
        return (string) spl_object_id($object);
    }
}
foreach (['removeAll', 'removeAllExcept'] as $operation) {
    foreach (['body', 'cleanup'] as $mode) {
        $storage = new HashCleanupStorage();
        $other = new SplObjectStorage();
        $key = new stdClass();
        $storage[$key] = new CleanupInfo('removed');
        if ($operation === 'removeAll') $other[$key] = 0;
        $storage->mode = $mode;
        try { $storage->$operation($other); }
        catch (Throwable $error) { echo $error->getMessage(), ';', count($storage), ';'; }
        unset($storage);
        echo "\n";
    }
}
