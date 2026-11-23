<?php
trait Role {
    public function original(): string { return 'trait'; }
}
class Base {
    use Role {
        Role::original as final saved;
        original as protected final;
    }
    public function keywordAlias(): string { return $this->final(); }
}
class OverridesOriginal extends Base {
    public function original(): string { return 'override'; }
}
$obj = new OverridesOriginal;
echo $obj->original(), ',', $obj->saved(), ',', $obj->keywordAlias(), "\n";
class OverridesAlias extends Base {
    public function saved(): string { return 'invalid'; }
}
