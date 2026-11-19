<?php
interface ContractA { public function run(): void; }
interface ContractB { public function run(int $value): void; }
interface ContractChild extends ContractA {}
interface Conflict extends ContractChild, ContractB {}
