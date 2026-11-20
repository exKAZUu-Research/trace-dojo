<?php
class Foreign {}
trait Used { function method() {} }
class UsesRule {
    use Used { Foreign::method as alias; }
}
