<?php
namespace Example {
    echo 'never';
    class ParentClass { public function method(callable $callback) {} }
    class ChildClass extends ParentClass { public function method(\Closure $callback) {} }
    function later(int&float $invalid) {}
}
