<?php
declare(strict_types=1);
namespace OCA\HyperOfficeGuard\Service;

final class GuardUnavailable extends \RuntimeException {
    public function __construct() {
        parent::__construct('Office permission coordination is unavailable. Check the actual share state before retrying.');
    }
}
