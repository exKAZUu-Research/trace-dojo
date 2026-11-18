<?php
class LocatedException extends Exception {
    protected string $file = '';
    protected int $line = 0;
    function update($file, $line) { $this->file=$file; $this->line=$line; }
}
class LocatedError extends Error {
    protected int $line;
    function invalid() { $this->line=[]; }
}
class LevelException extends ErrorException {
    protected int $severity = 1;
    function setLevel($value) { $this->severity = $value; }
}
function reportTypeError($callback) {
    try { $callback(); } catch (Throwable $error) { echo $error->getMessage(),"\n"; }
}
$exception=new LocatedException;
$exception->update('lesson.php', '12');
var_dump($exception->getFile(), $exception->getLine(), $exception->getPrevious());
reportTypeError(fn()=>$exception->update([], 0));
reportTypeError(fn()=>$exception->update('lesson.php', 'not a number'));
$error=new LocatedError;
reportTypeError(fn()=>$error->invalid());
$level=new LevelException;
reportTypeError(fn()=>$level->setLevel('missing'));
var_dump($level->getSeverity());
$iterator=new RegexIterator(new ArrayIterator([]),'~.~');
$iterator->replacement=123;
var_dump($iterator->replacement);
reportTypeError(fn()=>$iterator->replacement=[]);

class InheritedException extends Exception {
    function setBadLine() { $this->line=[]; }
    function setBadFileReference() { $reference =& $this->file; $reference=[]; }
}
class InheritedError extends Error {
    function setBadLineReference() { $reference =& $this->line; $reference=[]; }
}
class InheritedSeverity extends ErrorException {
    function setBadSeverity() { $this->severity=[]; }
}
reportTypeError(fn()=>(new InheritedException)->setBadLine());
reportTypeError(fn()=>(new InheritedException)->setBadFileReference());
reportTypeError(fn()=>(new InheritedError)->setBadLineReference());
reportTypeError(fn()=>(new InheritedSeverity)->setBadSeverity());
