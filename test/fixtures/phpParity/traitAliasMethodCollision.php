<?php
trait FirstMethod { function left() {} }
trait SecondMethod { function right() {} }
class Conflict {
    use FirstMethod, SecondMethod { left as right; }
}
