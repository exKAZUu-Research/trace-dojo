<?php
class ParentValue {
    public $child;
    public $change = 'before';
    public $old = 'old';
    public string $typed = 'typed';
    public int $uninitialized;
}
function alterParent() {
    global $parent;
    $parent->change = 'new';
    unset($parent->old, $parent->typed, $parent->dynamic);
    @$parent->fresh = 'fresh';
}
class DebugValue { function __debugInfo() { alterParent(); return []; } }
class ExportValue { public $value { get { alterParent(); return 1; } } }
foreach (['var_dump', 'print_r', 'var_export'] as $inspect) {
    $parent = new ParentValue;
    $parent->child = $inspect === 'var_export' ? new ExportValue : new DebugValue;
    @$parent->dynamic = 'dynamic';
    $inspect($parent);
    echo "\n";
    unset($parent);
}
class DynamicValues {
    public $value {
        get {
            $this->changed = 4;
            unset($this->removed);
            @$this->added = 5;
            return 1;
        }
    }
}
$values = new DynamicValues;
@$values->changed = 2;
@$values->removed = 3;
var_dump(get_object_vars($values));
class ParentScope {
    private $value = 1;
    function inspect() {
        foreach ($this as $key => $value) echo "$key=$value;";
        echo "\n";
        var_dump(get_object_vars($this));
        echo http_build_query($this), "\n";
        foreach ($this as &$value) $value++;
        var_dump($this->value);
    }
}
class ChildScope extends ParentScope { public $value = 4; }
(new ChildScope)->inspect();

class MutateArrayReference {
    function __debugInfo() {
        global $arrayReference;
        $arrayReference = 'new';
        return [];
    }
}
$arrayReference = 'old';
print_r([new MutateArrayReference, &$arrayReference]);

class DebugArrayReference {
    function __debugInfo() {
        global $arrayReference;
        return [new MutateArrayReference, &$arrayReference];
    }
}
$arrayReference = 'old';
var_dump(new DebugArrayReference);
$arrayReference = 'old';
print_r(new DebugArrayReference);
