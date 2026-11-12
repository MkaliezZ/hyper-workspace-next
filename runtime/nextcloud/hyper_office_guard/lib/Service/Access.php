<?php
declare(strict_types=1);
namespace OCA\HyperOfficeGuard\Service;

use OCA\Richdocuments\Db\Wopi;
use OCA\Richdocuments\Db\WopiMapper;
use OCA\Richdocuments\Service\UserScopeService;
use OCP\Constants;
use OCP\Files\File;
use OCP\Files\IRootFolder;
use OCP\IConfig;
use OCP\IGroupManager;
use OCP\IUserManager;

final class Access {
    public function __construct(
        private Settings $settings,
        private IConfig $config,
        private WopiMapper $tokens,
        private IUserManager $users,
        private IGroupManager $groups,
        private IRootFolder $root,
        private UserScopeService $scope,
    ) {}

    public function check(string $fileId, #[\SensitiveParameter] string $token): array {
        if (!preg_match('/^([1-9][0-9]*)(?:_([A-Za-z0-9]+)(?:_([0-9]+))?)?$/D', $fileId, $parts)
            || !preg_match('/^[A-Za-z0-9]{32}$/D', $token)) throw new AccessDenied();
        if (isset($parts[2]) && $parts[2] !== $this->config->getSystemValueString('instanceid')) throw new AccessDenied();
        $version = $parts[3] ?? '0';
        try {
            $wopi = $this->tokens->getWopiForToken($token);
        } catch (\Throwable) {
            throw new AccessDenied();
        }
        if ($wopi->getTokenType() !== Wopi::TOKEN_TYPE_USER || !empty($wopi->getShare())
            || (string)$wopi->getFileid() !== $parts[1] || (string)$wopi->getVersion() !== $version) throw new AccessDenied();
        $uid = $wopi->getEditorUid();
        if (!is_string($uid) || $uid === '') throw new AccessDenied();
        $user = $this->users->get($uid);
        if ($user === null || $user->getUID() !== $uid || !$user->isEnabled()
            || !$this->groups->isInGroup($uid, $this->settings->values()['member_group'])) throw new AccessDenied();
        // Match richdocuments' user scope before resolving group-folder ACLs.
        $this->scope->setUserScope($uid);
        $nodes = $this->root->getUserFolder($uid)->getById((int)$parts[1]);
        $read = false;
        $write = false;
        foreach ($nodes as $node) {
            if (!$node instanceof File) continue;
            $permissions = $node->getPermissions();
            if (($permissions & Constants::PERMISSION_READ) === 0) continue;
            $read = true;
            $write = $write || (($permissions & Constants::PERMISSION_UPDATE) !== 0);
        }
        if (!$read) throw new AccessDenied();
        return ['fileId' => $fileId, 'userId' => $uid, 'canRead' => true,
            'canWrite' => $write && (bool)$wopi->getCanwrite() && $version === '0'];
    }
}
