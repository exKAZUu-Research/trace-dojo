<?php interface I{public int|string $x{get;set;}}interface J extends I{public ?int $x{get;set;}}echo 'never';
