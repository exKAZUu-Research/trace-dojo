<?php
function innerFailure() { throw new RuntimeException('inner'); }
foreach ([false, true] as $fromCatch) {
    try {
        try { throw new Exception('original'); }
        catch (Exception $error) {
            if ($fromCatch) throw new LogicException('from catch');
            throw $error;
        }
        finally {
            try { innerFailure(); }
            catch (RuntimeException $inner) { echo $inner->getMessage(), "\n"; }
            $temporary = new stdClass;
            unset($temporary);
        }
    } catch (Exception $final) { echo get_class($final), ':', $final->getMessage(), "\n"; }
}
class InterruptedReturn {
    function __destruct() { throw new Exception('destructor'); }
    function fail() { innerFailure(); }
}
function discardReturn($call) {
    try { return [new InterruptedReturn]; }
    finally {
        if ($call) innerFailure();
        throw new Exception('finally');
    }
}
foreach ([false, true] as $call) {
    try { discardReturn($call); }
    catch (Throwable $error) {
        echo $error->getMessage(), ':', $error->getPrevious()?->getMessage(), "\n";
    }
}
foreach ([false, true] as $echo) {
    try {
        if ($echo) echo (new InterruptedReturn)->fail();
        else (new InterruptedReturn)->fail();
    } catch (Throwable $error) {
        echo $error->getMessage(), ':', $error->getPrevious()?->getMessage(), "\n";
    }
}
try { throw new Exception('uncaught'); }
finally {
    try { innerFailure(); }
    catch (RuntimeException $inner) { echo $inner->getMessage(), "\n"; }
}
