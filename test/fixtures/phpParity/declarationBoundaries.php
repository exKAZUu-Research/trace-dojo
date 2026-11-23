<?php
declare(ReviewDirective=1);
abstract class Getter {
    public int $value {
        get {
            goto done;
            echo 'skipped';
            done: return 3;
        }
    }
}
class Concrete extends Getter {}
function withDeferredDefault($value = self::X) { return $value; }
function &byReferenceVoid(): void {}
class WithDeferredConstant { const X = parent::Y; }
var_dump((new Concrete)->value, withDeferredDefault('given'));
