<?php
echo "before\n";
interface RepeatInterface extends Countable, Countable {}
echo "never\n";
