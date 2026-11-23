<?php
trait StringSource { function untyped() { return 'text'; } }
class InvalidStringable { use StringSource { untyped as __tostring; } }
