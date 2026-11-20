<?php
interface Leaf {}
interface OtherLeaf {}
interface Branch extends Leaf, OtherLeaf {}
function printClass(object $o) {
    echo str_replace("\0", "|", get_class($o)), "\n";
}
printClass(new class implements Leaf {});
printClass(new class implements Branch {});
trait Shared {}
class ImplementsLeaf implements Leaf {}
class UsesTrait { use Shared; }
if (false) { class Nested {} }
class ImplicitStringable { function __toString(): string { return ''; } }
class Hooked { public string $prop { get => 'x'; } }
class InheritedHook extends Hooked {}
class ChildBeforeParent extends ParentClass {}
class ParentClass {}
printClass(new class {});
class ChildAfterParent extends ParentClass {}
printClass(new class extends ChildAfterParent {});
class BracedName {
    const Name = self::class;
    const Missing = self::{'class'};
    static function test() {
        var_dump(self::{'class'} || true);
    }
}
var_dump(BracedName::Name);
try { BracedName::test(); } catch (Error $error) { echo $error->getMessage(), "\n"; }
try { echo BracedName::Missing . '!'; } catch (Error $error) { echo $error->getMessage(), "\n"; }
