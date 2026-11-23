<?php
class DropOnInspect {
    public $value = "live";
    function __destruct() {
        echo "drop;";
        throw new Exception("dtor");
    }
}
class DebugMutator {
    function __debugInfo() {
        global $object;
        $object->b = null;
        return [];
    }
}
class ExportMutator {
    public $change { get { global $object; $object->b = null; return "hook"; } }
}
foreach (['dump', 'print', 'print return', 'export', 'export return'] as $method) {
    echo "[$method]\n";
    $object = (object)['a' => str_starts_with($method, 'export') ? new ExportMutator : new DebugMutator];
    $object->b = new DropOnInspect;
    try {
        switch ($method) {
            case 'dump': var_dump($object, "later"); break;
            case 'print': print_r($object); break;
            case 'print return': echo print_r($object,true); break;
            case 'export': var_export($object); break;
            case 'export return': echo var_export($object,true); break;
        }
    } catch (Throwable $error) {
        echo "caught:",$error->getMessage(),"\n";
    }
}

class SnapshotMutator {
    function __construct(public string $target) {}
    function __debugInfo() {
        $GLOBALS[$this->target]->lost = null;
        return [];
    }
}
$inner = (object)['hook' => new SnapshotMutator('inner'), 'lost' => new DropOnInspect];
$outer = (object)['hook' => new SnapshotMutator('outer'), 'inner' => $inner, 'lost' => new DropOnInspect];
try {
    var_dump($outer);
} catch (Throwable $error) {
    echo $error->getMessage(), ' / ', $error->getPrevious()?->getMessage(), "\n";
}

$inner = (object)['hook' => new SnapshotMutator('inner'), 'lost' => new DropOnInspect];
$outer = (object)['inner' => $inner, 'hook' => new SnapshotMutator('outer'), 'lost' => new DropOnInspect];
try {
    var_dump($outer);
} catch (Throwable $error) {
    echo "caught:", $error->getMessage(), "\n";
}
