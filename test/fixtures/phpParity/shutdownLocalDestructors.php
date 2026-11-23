<?php
class ShutdownLocal {
    public function __destruct() {
        debug_print_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS);
    }
}
class StaticShutdownOwner {
    public function __construct(private bool $throws) {}
    public function __destruct() {
        if ($this->throws) throw new Exception('first');
        $local = new ShutdownLocal();
    }
}
static $owners;
$owners = (object) ['first' => new StaticShutdownOwner(true), 'second' => new StaticShutdownOwner(false)];
unset($owners);
echo "done;\n";
