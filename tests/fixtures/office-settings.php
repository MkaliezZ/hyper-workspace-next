<?php
// Exercise a generated configuration fragment without booting or changing Nextcloud.
declare(strict_types=1);

if ($argc !== 3 || !is_file($argv[1]) || filter_var($argv[2], FILTER_VALIDATE_IP) === false) {
    throw new RuntimeException('Usage: php office-settings.php FRAGMENT COLLABORA_IP');
}

$fragment = $argv[1];
$editorIp = $argv[2];
$otherIp = $editorIp === '192.0.2.19' ? '192.0.2.20' : '192.0.2.19';
$settings = '/index.php/apps/richdocuments/wopi/settings';
$public = [
    'overwritehost' => '192.168.10.50:8443',
    'overwriteprotocol' => 'https',
    'overwritecondaddr' => '^192\\.0\\.2\\.1$',
];
$internal = [
    'overwritehost' => 'nextcloud',
    'overwriteprotocol' => 'http',
    'overwritecondaddr' => '',
];

function evaluateFragment(string $fragment, array $server): array {
    $_SERVER = $server;
    $CONFIG = [];
    require $fragment;
    if (!is_array($CONFIG)) {
        throw new RuntimeException('The fragment must define a configuration array');
    }
    return $CONFIG;
}

$cases = [];
foreach (['nextcloud', 'nextcloud:80'] as $host) {
    foreach ([$settings, '/apps/richdocuments/wopi/settings'] as $path) {
        foreach (['', '?documentId=synthetic&token=synthetic'] as $query) {
            $cases[] = [
                'direct editor settings ' . $host . $path . $query,
                ['REMOTE_ADDR' => $editorIp, 'HTTP_HOST' => $host, 'REQUEST_URI' => $path . $query],
                true,
            ];
        }
    }
}

$valid = ['REMOTE_ADDR' => $editorIp, 'HTTP_HOST' => 'nextcloud', 'REQUEST_URI' => $settings];
$cases[] = ['CLI without request metadata', [], false];
$cases[] = ['wrong peer', array_replace($valid, ['REMOTE_ADDR' => $otherIp]), false];
$cases[] = ['forwarded peer cannot authorize', array_replace($valid, [
    'REMOTE_ADDR' => $otherIp, 'HTTP_X_FORWARDED_FOR' => $editorIp,
]), false];
$cases[] = ['forwarded host cannot authorize', array_replace($valid, [
    'HTTP_HOST' => '192.168.10.50:8443', 'HTTP_X_FORWARDED_HOST' => 'nextcloud',
]), false];
foreach (['192.168.10.50:8443', 'nextcloud.example.test', 'nextcloud:8443', 'nextcloud.', 'nextcloud:80@attacker.test', ''] as $host) {
    $cases[] = ['noninternal host ' . $host, array_replace($valid, ['HTTP_HOST' => $host]), false];
}
foreach ([
    '/prefix' . $settings,
    $settings . '/extra',
    $settings . '-extra',
    '/index.php/apps/richdocuments/wopi/files/42',
    '/index.php/apps/richdocuments/wopi/files/42/contents',
    '/index.php/avatar/employee/64',
    '/index.php/login',
    '/index.php/apps/richdocuments/wopi/%73ettings',
    '/index.php/apps/richdocuments/wopi/settings%2Fextra',
    '',
] as $path) {
    $cases[] = ['unrelated path ' . $path, array_replace($valid, ['REQUEST_URI' => $path]), false];
}
foreach (['REMOTE_ADDR', 'HTTP_HOST', 'REQUEST_URI'] as $key) {
    $missing = $valid;
    unset($missing[$key]);
    $cases[] = ['missing ' . $key, $missing, false];
}

$originalServer = $_SERVER;
try {
    foreach ($cases as [$name, $server, $allowed]) {
        $actual = evaluateFragment($fragment, $server);
        $expected = $allowed ? $internal : [];
        if ($actual !== $expected) {
            throw new RuntimeException('Unexpected callback scope: ' . $name);
        }
        if (!$allowed && array_replace($public, $actual) !== $public) {
            throw new RuntimeException('Public HTTPS configuration changed: ' . $name);
        }
    }
} finally {
    $_SERVER = $originalServer;
}
echo 'Office settings callback boundaries: ' . count($cases) . " passed\n";
