<?php
class MissingConstant {
    const C = ABSENT;
    public static $property = 1;
}
class DerivedConstant extends MissingConstant {}
class SelfConstant {
    const C = self::C;
    public static $property = 1;
}
class ParentConstant {
    const C = parent::C;
    public $property = 1;
}
class MissingPropertyDefault {
    public $property = ABSENT;
    public static $other = 4;
}
class MissingStaticDefault {
    public static $property = ABSENT;
}
foreach ([
    fn() => new MissingConstant,
    fn() => MissingConstant::$property,
    fn() => new DerivedConstant,
    fn() => SelfConstant::$property,
    fn() => new ParentConstant,
    fn() => MissingPropertyDefault::$other,
    fn() => new MissingStaticDefault,
] as $attempt) {
    try { $attempt(); } catch (Throwable $e) { echo $e->getMessage(), "\n"; }
}
class LaterConstant {
    const C = LATER;
    public static $property = self::C;
}
try { new LaterConstant; } catch (Throwable $e) { echo $e->getMessage(), "\n"; }
define('LATER', 2);
echo LaterConstant::$property, "\n";
