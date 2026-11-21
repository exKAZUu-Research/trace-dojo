<?php
class Properties {
    public string $stored { set => strtoupper($value); }
    public string $plain;
    public $virtual { get => 13; }
    protected $protected { get => 4; }
    public $other = 7;
}
$object = new Properties;
echo json_encode($object), "\n";
var_export(get_object_vars($object));
echo "\n";
var_export($object);
echo "\n";
try { unset($object->stored); }
catch (Throwable $error) { echo get_class($error), ": ", $error->getMessage(), "\n"; }
echo json_encode($object), "\n";
var_export(get_object_vars($object));
echo "\n";
class Traced {
    public $value {
        get {
            echo (new Exception)->getTraceAsString(), "\n";
            return 1;
        }
    }
    function __isset($name) {
        echo (new Exception)->getTraceAsString(), "\n";
        return true;
    }
    function __get($name) {
        echo (new Exception)->getTraceAsString(), "\n";
        return 2;
    }
}
get_object_vars(new Traced);
array_column([new Traced], 'value');
array_column([new Traced], 'fallback');
