<?php
class DynamicRead {
    public $p {
        get {
            $name = 'p';
            return $this->{$name};
        }
    }
}
class DynamicWrite {
    public $p {
        set($value) {
            $name = 'p';
            $this->{$name} = $value;
        }
        get => 1;
    }
}
class LiteralBacking {
    public $p { get { return $this->{'p'}; } }
    public $q { get { return $this->{"\x71"}; } }
}
class NestedReference {
    public $p {
        get {
            $callback = fn() => $this->p;
            $name = 'p';
            return $this->{$name};
        }
    }
}
foreach ([fn() => (new DynamicRead())->p, function () { $object = new DynamicWrite(); return $object->p = 3; }, fn() => (new NestedReference())->p] as $call) {
    try {
        $call();
    } catch (Error $error) {
        echo $error->getMessage(), "\n", $error->getTraceAsString(), "\n";
    }
}
$object = new LiteralBacking;
var_dump($object->p, $object->q);
