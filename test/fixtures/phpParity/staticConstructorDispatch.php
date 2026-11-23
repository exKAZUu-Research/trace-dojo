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

class ProtectedParent { protected function __construct() { echo "constructed\n"; } }
class ProtectedChild extends ProtectedParent { function invoke() { parent::__construct(); } }
class UnrelatedConstructorCaller { function invoke() { ProtectedParent::__construct(); } }
class StaticPrivateChild extends PrivateParent { static function invoke() { parent::__construct(); } }
foreach ([
    fn () => ProtectedParent::__construct(),
    fn () => PrivateParent::__construct(),
    fn () => (new UnrelatedConstructorCaller)->invoke(),
    fn () => StaticPrivateChild::invoke(),
] as $call) {
    try { $call(); }
    catch (Error $error) { echo $error->getMessage(), "\n"; }
}
$protectedChild = new class extends ProtectedChild { function __construct() {} };
$protectedChild->invoke();

class OwnPrivateContext {
    private function __construct() { echo "private body\n"; }
    static function tryFromChild() { (new PrivateSubclass)->retry(); }
    function retry() { self::__construct(); }
}
class PrivateSubclass extends OwnPrivateContext { function __construct() {} }
try { OwnPrivateContext::tryFromChild(); }
catch (Error $error) { echo $error->getMessage(), "\n"; }
abstract class AbstractConstructor { abstract public function __construct(); }
interface ConstructorContract { function __construct(); }
class ConcreteConstructor extends AbstractConstructor implements ConstructorContract {
    function __construct() { parent::__construct(); ConstructorContract::__construct(); }
}
new ConcreteConstructor;
try { AbstractConstructor::__construct(); }
catch (Error $error) { echo $error->getMessage(), "\n"; }
