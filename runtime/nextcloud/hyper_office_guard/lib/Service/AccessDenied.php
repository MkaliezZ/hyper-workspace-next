<?php
declare(strict_types=1);
namespace OCA\HyperOfficeGuard\Service;

final class AccessDenied extends \RuntimeException {
    public function __construct() {
        parent::__construct('Office access denied.');
    }
}
