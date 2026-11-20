<?php
interface DefaultArgument { public function run($value = 1); }
interface TwoArguments { public function run($value, $other); }
abstract class ParentClass implements DefaultArgument {}
class Compatible extends ParentClass implements TwoArguments {
    public function run($value = 1, $other = null) { echo $value; }
}
(new Compatible())->run();
abstract class Conflict extends ParentClass implements TwoArguments {}
