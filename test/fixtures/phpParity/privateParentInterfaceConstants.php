<?php interface I{const X=1;}class P{private const X=2;function values(){echo self::X,':',static::X,';';}}class C extends P implements I{}echo C::X,';';(new C)->values();class D{private const X=1;}class E extends D implements I{}echo E::X;

class PrivateConstantParent { private const MISSING = 1; }
class PrivateConstantChild extends PrivateConstantParent {
    function read($value = self::MISSING) {}
}
foreach ([PrivateConstantParent::class, PrivateConstantChild::class] as $class) {
    try { echo $class::MISSING; }
    catch (Throwable $error) { echo $error->getMessage(), "\n"; }
}
try { (new PrivateConstantChild())->read(); }
catch (Throwable $error) { echo $error->getMessage(), "\n"; }
