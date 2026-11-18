<?php
class HookNames {
    public string $name {
        get {
            $closure = function () { return __FUNCTION__; };
            return $closure();
        }
        set {
            $closure = fn () => throw new Exception(__FUNCTION__);
            $closure();
        }
    }
    public string $type {
        get {
            $closure = function (string $input) {};
            $closure([]);
            return '';
        }
    }
}
$object = new HookNames;
echo $object->name, "\n";
try { $object->name = 'value'; }
catch (Exception $error) { echo $error->getMessage(), "\n", $error->getTraceAsString(), "\n"; }
try { echo $object->type; }
catch (TypeError $error) { echo $error->getMessage(), "\n"; }

$anonymous = new class {
    public string $name {
        get => (fn () => __FUNCTION__)();
        set { $this->name = (fn () => __METHOD__)(); }
    }
    function inspect() {
        return (function () {
            return (fn () => __FUNCTION__)();
        })();
    }
};
echo str_replace("\0", "~", $anonymous->name), "\n";
echo str_replace("\0", "~", $anonymous->inspect()), "\n";
