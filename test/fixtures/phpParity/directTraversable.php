<?php
interface CustomTraversable extends Traversable {}
echo "before\n";
class DirectTraversable implements CustomTraversable {}
echo "never\n";
