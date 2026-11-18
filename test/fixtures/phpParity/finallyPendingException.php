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
try { throw new Exception('uncaught'); }
finally {
    try { innerFailure(); }
    catch (RuntimeException $inner) { echo $inner->getMessage(), "\n"; }
}
