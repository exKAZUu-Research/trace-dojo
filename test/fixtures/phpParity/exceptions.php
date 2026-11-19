<?php
class MyException extends Exception {
    public function __construct(string $message, private string $extra = "x") { parent::__construct($message, 42); }
    public function getExtra(): string { return $this->extra; }
}
function risky(int $n) { if ($n > 2) throw new MyException("too big: $n", "info"); return $n; }
try { echo risky(1), "\n"; echo risky(5), "\n"; } catch (MyException $e) { echo get_class($e), " ", $e->getMessage(), " ", $e->getCode(), " ", $e->getExtra(), " line ", $e->getLine(), "\n"; } finally { echo "finally\n"; }
function f() { try { return "try"; } finally { echo "in finally\n"; } }
echo f(), "\n";
function g() { try { throw new Exception("a"); } catch (Exception $e) { return "caught " . $e->getMessage(); } finally { echo "g-finally\n"; } }
echo g(), "\n";
try { try { throw new RuntimeException("inner"); } finally { echo "inner finally\n"; } } catch (Exception $e) { echo "outer caught ", $e->getMessage(), "\n"; }
try { throw new InvalidArgumentException("bad arg"); } catch (RuntimeException | InvalidArgumentException $e) { echo "multi ", get_class($e), "\n"; }
try { intdiv(1, 0); } catch (DivisionByZeroError $e) { echo $e->getMessage(), "\n"; }
try { echo 1 % 0; } catch (DivisionByZeroError $e) { echo $e->getMessage(), "\n"; }
try { echo 1 / 0; } catch (DivisionByZeroError $e) { echo $e->getMessage(), "\n"; }
try { $nn = null; $nn->method(); } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { throw new Exception("with prev", 1, new LogicException("cause")); } catch (Exception $e) { echo $e->getPrevious()->getMessage(), "\n"; }
$e = new Exception("msg"); echo $e->getLine(), " ", $e->getFile() === __FILE__ ? "same" : "other", "\n";
function thrower() { throw new DomainException("deep"); }
function middle() { thrower(); }
try { middle(); } catch (Exception $e) { echo $e->getTraceAsString(), "\n"; print_r(array_map(fn($f) => $f['function'], $e->getTrace())); }
try { throw new ErrorException("ee", 1, E_WARNING); } catch (ErrorException $e) { echo $e->getSeverity(), "\n"; }
set_error_handler(function($no, $str, $file, $line) { echo "handler: [$no] $str at $line\n"; return true; });
echo $undefinedVar;
$arr = []; echo $arr['missing'];
restore_error_handler();
$x = @$arr['quiet'];
echo "end\n";
class RestoredHandler {
    function __construct(private $kind) {}
    function __invoke(...$args) { return true; }
    function __destruct() {
        echo "release:$this->kind;";
        if ($this->kind === 'error') @trigger_error('during restore', E_USER_NOTICE);
        throw new Exception('cleanup');
    }
}
set_error_handler(function () { echo 'previous handler;'; return true; });
set_error_handler(new RestoredHandler('error'));
try { restore_error_handler(); }
catch (Throwable $error) { echo $error->getMessage(), ';'; }
trigger_error('after restore', E_USER_NOTICE);
restore_error_handler();
echo "\n";
$previous = function () {};
set_exception_handler($previous);
set_exception_handler([new RestoredHandler('exception'), '__invoke']);
try { restore_exception_handler(); }
catch (Throwable $error) { echo $error->getMessage(), ';'; }
var_dump(set_exception_handler(null) === $previous);
restore_exception_handler();
restore_exception_handler();
class ReplacingHandler {
    function __invoke(Throwable $error) {}
    function __destruct() {
        $previous = set_exception_handler(static function () {});
        echo 'during:', get_debug_type($previous), ';';
    }
}
set_exception_handler(new ReplacingHandler);
restore_exception_handler();
echo 'restored:', get_debug_type(set_exception_handler(null)), "\n";
restore_exception_handler();
restore_exception_handler();
throw new MyException("uncaught!");
