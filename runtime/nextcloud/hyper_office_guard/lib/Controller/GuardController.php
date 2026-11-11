<?php
declare(strict_types=1);
namespace OCA\HyperOfficeGuard\Controller;

use OCA\HyperOfficeGuard\Service\Access;
use OCA\HyperOfficeGuard\Service\AccessDenied;
use OCA\HyperOfficeGuard\Service\Settings;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IRequest;

final class GuardController extends Controller {
    public function __construct(IRequest $request, private Settings $settings, private Access $access) {
        parent::__construct('hyper_office_guard', $request);
    }

    #[NoAdminRequired]
    #[NoCSRFRequired]
    #[PublicPage]
    public function check(string $fileId, #[\SensitiveParameter] string $token): JSONResponse {
        try {
            // Deliberately ignore forwarded addresses, even trusted-proxy headers.
            $this->settings->authorize((string)($_SERVER['REMOTE_ADDR'] ?? ''), $this->request->getHeader('X-Hyper-Office-Guard-Secret'));
            return new JSONResponse($this->access->check($fileId, $token));
        } catch (AccessDenied) {
            return new JSONResponse(['error' => 'access_denied'], 403);
        } catch (\Throwable) {
            return new JSONResponse(['error' => 'authorization_unavailable'], 503);
        }
    }
}
