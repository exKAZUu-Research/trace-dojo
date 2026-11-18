<?php
class NoConstructor {
    function __call($name, $arguments) { echo "magic $name\n"; }
    static function __callStatic($name, $arguments) { echo "static magic $name\n"; }
}
class CallsParent extends NoConstructor {
    function __construct($dynamic) {
        if ($dynamic) {
            $method = '__construct';
            parent::$method();
        } else parent::__construct();
    }
}
try { new CallsParent(false); }
catch (Error $error) { echo $error->getMessage(), "\n"; }
new CallsParent(true);
try { NoConstructor::__construct(); }
catch (Error $error) { echo $error->getMessage(), "\n"; }
class PrivateParent { private function __construct() {} }
class CallsPrivate extends PrivateParent {
    function __construct() { parent::__construct(); }
}
try { new CallsPrivate; }
catch (Error $error) { echo $error->getMessage(), "\n"; }
