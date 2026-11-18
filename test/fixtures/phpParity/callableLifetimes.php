<?php
abstract class HasAbstract { abstract static function f(); }
abstract class InheritsAbstract extends HasAbstract {}
foreach (['HasAbstract::f', ['HasAbstract', 'f'], 'InheritsAbstract::f', ['InheritsAbstract', 'f']] as $callback) {
    var_dump(is_callable($callback));
    foreach ([fn() => $callback(), fn() => call_user_func($callback), fn() => Closure::fromCallable($callback)] as $call) {
        try { $call(); } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
    }
}
class Receiver {
    function __construct(public $value) {}
    function method() { echo $this->value, "\n"; }
}
function changeMember() { global $object; $object->receiver = new Receiver(2); return 'method'; }
$object = (object)['receiver' => new Receiver(1)];
$object->receiver->{changeMember()}();
$object = (object)['receiver' => new Receiver(3)];
$object->receiver?->{changeMember()}();
function changeIndex() { global $array; $array[0] = new Receiver(2); return 'method'; }
$array = [new Receiver(4)];
$array[0]->{changeIndex()}();
$object = new class {
    function identify() {
        var_dump(get_called_class() === get_class($this), get_class() === self::class);
    }
};
$object->identify();
