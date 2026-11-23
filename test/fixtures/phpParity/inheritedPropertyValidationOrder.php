<?php
class BaseProperties {
    public int $first;
    public int $second;
}
class InvalidProperties extends BaseProperties {
    public string $second;
    public string $first;
}
