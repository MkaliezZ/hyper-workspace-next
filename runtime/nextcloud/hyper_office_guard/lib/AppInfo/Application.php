<?php
declare(strict_types=1);
namespace OCA\HyperOfficeGuard\AppInfo;

use OCA\Files_Sharing\Event\UserShareAccessUpdatedEvent;
use OCA\HyperOfficeGuard\Listener\AccessChangedListener;
use OCA\HyperOfficeGuard\Middleware\ShareMutationMiddleware;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCP\Group\Events\GroupDeletedEvent;
use OCP\Group\Events\UserRemovedEvent;
use OCP\Share\Events\ShareDeletedEvent;
use OCP\User\Events\UserDeletedEvent;
use OCP\Util;

final class Application extends App implements IBootstrap {
    public function __construct(array $urlParams = []) { parent::__construct('hyper_office_guard', $urlParams); }
    public function register(IRegistrationContext $context): void {
        $context->registerMiddleware(ShareMutationMiddleware::class, true);
        foreach ([ShareDeletedEvent::class, UserShareAccessUpdatedEvent::class, UserRemovedEvent::class, GroupDeletedEvent::class, UserDeletedEvent::class] as $event) {
            $context->registerEventListener($event, AccessChangedListener::class);
        }
    }
    public function boot(IBootContext $context): void {
        $context->injectFn(function (AccessChangedListener $listener): void {
            // NC 33 still emits permission updates through this legacy hook.
            Util::connectHook('OCP\\Share', 'post_update_permissions', $listener, 'legacy');
        });
    }
}
