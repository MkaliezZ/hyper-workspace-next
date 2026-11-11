<?php
declare(strict_types=1);
namespace OCA\HyperOfficeGuard\Listener;

use OCA\HyperOfficeGuard\Service\Gateway;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;

final class AccessChangedListener implements IEventListener {
    public function __construct(private Gateway $gateway) {}
    public function handle(Event $event): void {
        $this->gateway->invalidate();
    }
    public function legacy(array $parameters): void {
        $this->gateway->invalidate();
    }
}
