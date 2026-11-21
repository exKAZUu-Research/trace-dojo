<?php
trait Defaults {
    public function check(
        $a = self::class,
        $b = parent::class,
        $c = __CLASS__,
        $d = 'prefix' . self::class,
        $e = self::VALUE,
        $f = __METHOD__,
    ) {}
}
class Base {}
class UsingTrait extends Base {
    use Defaults { check as alias; }
}
class Child extends UsingTrait {
    public function alias() {}
}
