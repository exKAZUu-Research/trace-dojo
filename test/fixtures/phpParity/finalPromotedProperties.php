<?php
class FinalValues {
    public function __construct(
        final $plain,
        final public int $before = 1,
        protected final int $after = 2,
        readonly final int $readOnly = 3,
        final private(set) int $restricted = 4,
        final private int $private = 5,
    ) {}
}
var_dump(new FinalValues(0));
if (true) { class ConflictingValues extends FinalValues { public int $private; } }
