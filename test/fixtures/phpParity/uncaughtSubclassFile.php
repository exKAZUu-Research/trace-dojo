<?php
class LocatedError extends Exception {
    function __construct() { parent::__construct("bad"); $this->file = "input.txt"; $this->line = 7; }
}
throw new LocatedError();
