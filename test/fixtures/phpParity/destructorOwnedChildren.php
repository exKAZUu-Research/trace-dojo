<?php
class OwnsChild {
    public $link;
    function __construct(public $label, private $storage = 'none') {}
    function __destruct() {
        echo $this->label, ';';
        if ($this->storage === 'direct') $this->link = new self('child');
        if ($this->storage === 'array') $this->link = [new self('array child')];
        if ($this->storage === 'shared') {
            $this->link = new self('shared child');
            $GLOBALS['shared'] = $this->link;
        }
    }
}
foreach (['direct', 'array', 'shared'] as $storage) {
    $owner = new OwnsChild('owner', $storage);
    unset($owner);
    echo "end\n";
}
unset($shared);
