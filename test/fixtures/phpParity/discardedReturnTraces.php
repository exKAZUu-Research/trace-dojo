<?php
class O { function __destruct() { throw new Exception('destroy'); } }
function f() {
    return new O;
}
function g() {
    return f();
}
function h() {
    try { return new O; } finally { echo 'finally;'; }
}
class H {
    function m() { return new O; }
    static function s() { return new O; }
}
try { f(); } catch (Throwable $e) { echo $e->getTraceAsString(), "\n"; }
try { (new H)->m(); } catch (Throwable $e) { echo $e->getTraceAsString(), "\n"; }
try { H::s(); } catch (Throwable $e) { echo $e->getTraceAsString(), "\n"; }
try { g(); } catch (Throwable $e) { echo $e->getTraceAsString(), "\n"; }
try { h(); } catch (Throwable $e) { echo $e->getTraceAsString(), "\n"; }
function local() { $a=new O; return 1; }
try { local(); } catch (Throwable $e) { echo $e->getTraceAsString(), "\n"; }
try { call_user_func('f'); } catch (Throwable $e) { echo $e->getTraceAsString(), "\n"; }
try { call_user_func_array('f',[]); } catch (Throwable $e) { echo $e->getTraceAsString(), "\n"; }
$callback = 'call_user_func';
try { $callback('f'); } catch (Throwable $e) { echo $e->getTraceAsString(), "\n"; }
