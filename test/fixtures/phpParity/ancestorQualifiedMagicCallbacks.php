<?php
error_reporting(E_ALL & ~E_DEPRECATED);
class CallbackBase {
    function __call($name, $args) { echo 'base ', get_class($this), " $name\n"; }
    function invokeOn($receiver) {
        foreach (['parent::missing', 'CallbackBase::missing'] as $method) {
            try { call_user_func([$receiver, $method]); }
            catch (Throwable $e) { echo $e->getMessage(), "\n"; }
        }
    }
}
class CallbackChild extends CallbackBase {
    function __call($name, $args) { echo 'child ', get_class($this), " $name\n"; }
}
class CallbackSibling extends CallbackBase {}
$child = new CallbackChild();
$child->invokeOn($child);
$child->invokeOn(new CallbackSibling());
(new CallbackBase())->invokeOn($child);
try { call_user_func([$child, 'CallbackBase::missing']); }
catch (Throwable $e) { echo $e->getMessage(), "\n"; }
class StaticBase {
    static function __callStatic($name, $args) { echo static::class, " $name\n"; }
}
class StaticChild extends StaticBase {}
call_user_func([new StaticChild(), 'StaticBase::missing']);
