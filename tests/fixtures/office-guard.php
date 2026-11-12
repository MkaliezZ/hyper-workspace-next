<?php
declare(strict_types=1);
// Boundary fixtures use small interface doubles. Real NC 33 class loading and
// browser/OCS acceptance are separate checks; no token or source data is printed.
namespace OCP {
    interface IConfig { public function getSystemValue($key, $default = null); public function getSystemValueString($key, $default = ''); }
    interface IUserManager { public function get($uid); }
    interface IGroupManager { public function isInGroup($uid, $group); }
    class Constants { public const PERMISSION_READ = 1; public const PERMISSION_UPDATE = 2; }
}
namespace OCP\Files {
    interface File { public function getPermissions(); }
    interface IRootFolder { public function getUserFolder($uid); }
}
namespace OCP\Http\Client { interface IClientService { public function newClient(); } }
namespace Psr\Log { interface LoggerInterface { public function warning($message, array $context = []); } }
namespace OCP\AppFramework\Http {
    class Response { public function __construct(public int $status = 200) {} }
    class JSONResponse extends Response { public function __construct(public array $data, int $status = 200) { parent::__construct($status); } }
}
namespace OCP\AppFramework { class Middleware {} }
namespace OCA\Files_Sharing\Controller { class ShareAPIController {} }
namespace OCA\Richdocuments\Db {
    class Wopi {
        public const TOKEN_TYPE_USER = 0;
        public int $type = 0;
        public ?string $share = null;
        public string $uid = 'office-alice';
        public string $file = '42';
        public string $version = '0';
        public bool $write = true;
        public function getTokenType() { return $this->type; }
        public function getShare() { return $this->share; }
        public function getEditorUid() { return $this->uid; }
        public function getFileid() { return $this->file; }
        public function getVersion() { return $this->version; }
        public function getCanwrite() { return $this->write; }
    }
    class WopiMapper {
        public bool $valid = true;
        public function __construct(public Wopi $value) {}
        public function getWopiForToken($token) { if (!$this->valid) throw new \RuntimeException('expired'); return $this->value; }
    }
}
namespace OCA\Richdocuments\Service {
    class UserScopeService { public ?string $uid = null; public function setUserScope($uid) { $this->uid = $uid; } }
}
namespace {
    $directory = $argv[1] ?? '';
    spl_autoload_register(static function (string $class) use ($directory): void {
        $prefix = 'OCA\\HyperOfficeGuard\\';
        if (str_starts_with($class, $prefix)) require $directory . '/lib/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    });
    $passed = 0;
    function check(bool $value): void { global $passed; if (!$value) throw new \RuntimeException('Guard boundary assertion failed'); ++$passed; }
    function denied(callable $fn): bool { try { $fn(); return false; } catch (\OCA\HyperOfficeGuard\Service\AccessDenied) { return true; } }
    $config = new class implements \OCP\IConfig {
        public array $value = ['secret' => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'gateway_url' => 'http://office-gateway:9982', 'gateway_ips' => ['172.18.0.4', 'fd00::4'], 'member_group' => 'hyper-members'];
        public function getSystemValue($key, $default = null) { return $key === 'hyper_office_guard' ? $this->value : $default; }
        public function getSystemValueString($key, $default = '') { return $key === 'instanceid' ? 'ocfixture' : $default; }
    };
    $settings = new \OCA\HyperOfficeGuard\Service\Settings($config);
    $secret = str_repeat('a', 64);
    $settings->authorize('172.18.0.4', $secret); check(true);
    $settings->authorize('fd00:0:0:0:0:0:0:4', $secret); check(true);
    check(denied(fn() => $settings->authorize('172.18.0.5', $secret)));
    check(denied(fn() => $settings->authorize('172.18.0.4', str_repeat('b', 64))));
    check(denied(fn() => $settings->authorize('', $secret)));
    $user = new class { public bool $enabled = true; public function getUID() { return 'office-alice'; } public function isEnabled() { return $this->enabled; } };
    $users = new class($user) implements \OCP\IUserManager { public bool $exists = true; public function __construct(public object $value) {} public function get($uid) { return $this->exists ? $this->value : null; } };
    $groups = new class implements \OCP\IGroupManager { public bool $member = true; public function isInGroup($uid, $group) { return $this->member && $group === 'hyper-members'; } };
    $node = new class implements \OCP\Files\File { public int $permissions = 3; public function getPermissions() { return $this->permissions; } };
    $folder = new class($node) { public bool $visible = true; public function __construct(public object $node) {} public function getById($id) { return $this->visible ? [$this->node] : []; } };
    $root = new class($folder) implements \OCP\Files\IRootFolder { public function __construct(public object $folder) {} public function getUserFolder($uid) { return $this->folder; } };
    $wopi = new \OCA\Richdocuments\Db\Wopi();
    $tokens = new \OCA\Richdocuments\Db\WopiMapper($wopi);
    $scope = new \OCA\Richdocuments\Service\UserScopeService();
    $access = new \OCA\HyperOfficeGuard\Service\Access($settings, $config, $tokens, $users, $groups, $root, $scope);
    $token = str_repeat('B', 32);
    $inspect = fn() => $access->check('42_ocfixture', $token);
    check($inspect() === ['fileId' => '42_ocfixture', 'userId' => 'office-alice', 'canRead' => true, 'canWrite' => true]);
    check($scope->uid === 'office-alice');
    $node->permissions = 1; check($inspect()['canWrite'] === false); // Old token still says writable.
    $node->permissions = 2; check(denied($inspect));
    $node->permissions = 3; $folder->visible = false; check(denied($inspect)); $folder->visible = true;
    $user->enabled = false; check(denied($inspect)); $user->enabled = true;
    $users->exists = false; check(denied($inspect)); $users->exists = true;
    $groups->member = false; check(denied($inspect)); $groups->member = true;
    $wopi->type = 1; check(denied($inspect)); $wopi->type = 2; check(denied($inspect)); $wopi->type = 0;
    $wopi->share = 'public'; check(denied($inspect)); $wopi->share = null;
    $wopi->file = '43'; check(denied($inspect)); $wopi->file = '42';
    $wopi->write = false; check($inspect()['canWrite'] === false); $wopi->write = true;
    $wopi->version = '9'; check($access->check('42_ocfixture_9', $token)['canWrite'] === false); check(denied($inspect)); $wopi->version = '0';
    $tokens->valid = false; check(denied($inspect)); $tokens->valid = true;
    check(denied(fn() => $access->check('42_other', $token)));
    check(denied(fn() => $access->check('42_ocfixture_0_extra', $token)));
    check(denied(fn() => $access->check('42_ocfixture', 'invalid')));

    $http = new class implements \OCP\Http\Client\IClientService {
        public array $actions = [];
        public ?string $fail = null;
        public function newClient() { return $this; }
        public function post($url, $options) {
            $action = basename($url); $this->actions[] = $action;
            if ($action === $this->fail) throw new \RuntimeException('upstream details must not escape');
            return new class { public function getStatusCode() { return 200; } public function getBody() { return '{"ok":true}'; } };
        }
    };
    $logger = new class implements \Psr\Log\LoggerInterface { public function warning($message, array $context = []) {} };
    $gateway = new \OCA\HyperOfficeGuard\Service\Gateway($settings, $http, $logger);
    $middleware = new \OCA\HyperOfficeGuard\Middleware\ShareMutationMiddleware($gateway);
    $controller = new \OCA\Files_Sharing\Controller\ShareAPIController();
    $response = new \OCP\AppFramework\Http\Response();
    $middleware->beforeController($controller, 'deleteShare');
    check($http->actions === ['pause']);
    check($middleware->afterController($controller, 'deleteShare', $response) === $response);
    check($http->actions === ['pause', 'revalidate']);
    $http->actions = []; $http->fail = 'pause';
    try { $middleware->beforeController($controller, 'updateShare'); check(false); }
    catch (\OCA\HyperOfficeGuard\Service\GuardUnavailable $e) { check($middleware->afterException($controller, 'updateShare', $e)->status === 503); }
    check($http->actions === ['pause', 'revalidate']);
    $http->actions = []; $http->fail = null;
    $middleware->beforeController($controller, 'updateShare'); $http->fail = 'revalidate';
    check($middleware->afterController($controller, 'updateShare', $response)->status === 503);
    $http->actions = []; $http->fail = null;
    $middleware->beforeController($controller, 'getShare');
    check($middleware->afterController($controller, 'getShare', $response) === $response && $http->actions === []);
    echo 'office_guard_boundaries=' . $passed . ' passed' . PHP_EOL;
}
