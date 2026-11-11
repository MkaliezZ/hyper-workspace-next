<?php
declare(strict_types=1);
namespace OCA\HyperOfficeGuard\Service;

use OCP\IConfig;

final class Settings {
    public function __construct(private IConfig $config) {}

    public function values(): array {
        $value = $this->config->getSystemValue('hyper_office_guard', []);
        if (!is_array($value) || !is_string($value['secret'] ?? null)
            || !preg_match('/^[a-f0-9]{64}$/D', $value['secret'])
            || !is_string($value['gateway_url'] ?? null)
            || !is_string($value['member_group'] ?? null)
            || $value['member_group'] === '' || strlen($value['member_group']) > 256
            || !is_array($value['gateway_ips'] ?? null) || count($value['gateway_ips']) === 0) {
            throw new GuardUnavailable();
        }
        $url = parse_url($value['gateway_url']);
        if (!is_array($url) || !in_array($url['scheme'] ?? '', ['http', 'https'], true)
            || !in_array($url['host'] ?? '', ['office-gateway'], true)
            || ($url['port'] ?? null) !== 9982 || !in_array($url['path'] ?? '', ['', '/'], true)
            || isset($url['query']) || isset($url['fragment'])
            || isset($url['user']) || isset($url['pass'])) {
            throw new GuardUnavailable();
        }
        foreach ($value['gateway_ips'] as $ip) {
            if (!is_string($ip) || filter_var($ip, FILTER_VALIDATE_IP) === false) throw new GuardUnavailable();
        }
        return $value;
    }

    public function authorize(string $remote, #[\SensitiveParameter] string $secret): void {
        $value = $this->values();
        $peer = @inet_pton($remote);
        $allowed = false;
        foreach ($value['gateway_ips'] as $ip) {
            if ($peer !== false && inet_pton($ip) === $peer) $allowed = true;
        }
        if (!$allowed || !hash_equals($value['secret'], $secret)) throw new AccessDenied();
    }
}
