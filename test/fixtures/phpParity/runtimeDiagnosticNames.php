<?php
class Base {
    public static $value;
    public int $hook { get => 3; }
}
class Child extends Base {}
function show(callable $f) {
    try { var_dump($f()); }
    catch (Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
}
show(fn() => throw new stdClass());
show(fn() => throw 1);
show(fn() => strtr('abc', 'a'));
show(fn() => get_parent_class('UnknownClass'));
show(fn() => get_parent_class(Child::class));
show(fn() => get_parent_class(Base::class));
show(function () { foreach (new Child() as &$value) {} });
show(function () { $property = 'value'; unset(Child::${$property}); });
