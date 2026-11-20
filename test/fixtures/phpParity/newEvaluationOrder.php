<?php
class N {} function f() { echo "f\n"; return 1; }
new N(f());
class P { private function __construct() {} }
try { new P(f()); } catch (Error $e) { echo $e->getMessage(), "\n"; }
