<?php
declare(strict_types=1);
namespace OCA\HyperOfficeGuard\Service;

use OCP\Http\Client\IClientService;
use Psr\Log\LoggerInterface;

final class Gateway {
    public function __construct(private Settings $settings, private IClientService $clients, private LoggerInterface $logger) {}

    public function notify(string $action, ?string $id = null): void {
        if (!in_array($action, ['pause', 'revalidate', 'invalidate'], true)
            || ($action !== 'invalidate' && (!is_string($id) || !preg_match('/^[a-f0-9]{32}$/D', $id)))) {
            throw new GuardUnavailable();
        }
        try {
            $settings = $this->settings->values();
            $response = $this->clients->newClient()->post(rtrim($settings['gateway_url'], '/') . '/' . $action, [
                'headers' => ['Content-Type' => 'application/json', 'X-Hyper-Office-Guard-Secret' => $settings['secret']],
                'body' => $id === null ? '{}' : json_encode(['id' => $id], JSON_THROW_ON_ERROR),
                'timeout' => 8,
                'connect_timeout' => 1,
                'allow_redirects' => false,
                'http_errors' => false,
                'verify' => true,
                'nextcloud' => ['allow_local_address' => true],
            ]);
            if ($response->getStatusCode() !== 200) throw new GuardUnavailable();
            $body = $response->getBody();
            if (!is_string($body) || strlen($body) > 4096) throw new GuardUnavailable();
            $value = json_decode($body, true, 8, JSON_THROW_ON_ERROR);
            if (!is_array($value) || ($value['ok'] ?? null) !== true) throw new GuardUnavailable();
        } catch (\Throwable) {
            // HTTP exceptions may contain authentication headers and URLs.
            throw new GuardUnavailable();
        }
    }

    public function invalidate(): void {
        try {
            $this->notify('invalidate');
        } catch (\Throwable) {
            // Post-change hooks cannot undo a source mutation. The gateway's
            // short lease is the fail-closed fallback, not a successful callback.
            $this->logger->warning('Office permission notification failed; active sessions require lease revalidation.', ['app' => 'hyper_office_guard']);
        }
    }
}
