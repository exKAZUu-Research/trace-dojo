<?php
interface A0 {} interface B0 {} interface A extends A0 {} interface B extends B0 {} interface Cc {}
interface X extends A, B, Cc {}
interface Y extends Cc, A {}
interface Z extends X {}
class K implements X {} class L implements Z {}
foreach (["X","Y","Z","K","L"] as $n) { echo $n, ": ", implode(",", class_implements($n)), "\n"; }