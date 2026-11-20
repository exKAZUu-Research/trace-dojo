<?php
class A { function m() { return __METHOD__; } } class B extends A {} echo (new B)->m(), "\n";
$x = new class { function m() { return __METHOD__; } }; echo $x->m(), "\n";
class Q { function s(): static { return new Q; } } $a = new class extends Q {}; try { $a->s(); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
