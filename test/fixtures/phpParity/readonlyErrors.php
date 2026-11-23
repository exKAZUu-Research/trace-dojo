<?php
class R { public readonly int $u; public readonly array $a; public function __construct() { $this->a = [1]; } }
$r = new R;
try { $r->u = 1; } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { $r->a[] = 2; } catch (Error $e) { echo $e->getMessage(), "\n"; }
class U { public private(set) array $tags = []; public protected(set) int $n = 0; }
$u = new U;
try { $u->tags[] = 'x'; } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { $u->n = 5; } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { $u->tags = []; } catch (Error $e) { echo $e->getMessage(), "\n"; }
final class P { public function __construct(public readonly int $x) {} }
$p = new P(1);
try { $q = clone($p, ['x' => 10]); } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { $p->x++; } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { unset($p->x); } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { $ref = &$p->x; } catch (Error $e) { echo $e->getMessage(), "\n"; }
