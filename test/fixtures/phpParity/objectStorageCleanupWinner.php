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
