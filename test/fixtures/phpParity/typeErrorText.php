<?php
function f(int $x) {}
function g($a, $b) {}
try { f("abc"); } catch (TypeError $e) { echo $e, "\n---\n"; echo $e->getMessage(), "\n---\n"; }
try { g(1); } catch (ArgumentCountError $e) { echo $e, "\n---\n"; echo $e->getMessage(), "\n---\n"; }
class MyTE extends TypeError {}
try { throw new MyTE("x, called in y"); } catch (TypeError $e) { echo $e, "\n---\n"; }
try { throw new TypeError("x, called in y"); } catch (TypeError $e) { echo $e, "\n---\n"; }
f("zzz");
