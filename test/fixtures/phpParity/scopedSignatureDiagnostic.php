<?php
interface SignatureOwner { function check(self $value): self; }
class Implementation implements SignatureOwner { public function check(self $value): self {} }
