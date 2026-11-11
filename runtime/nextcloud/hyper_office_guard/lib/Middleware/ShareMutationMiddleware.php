<?php
declare(strict_types=1);
namespace OCA\HyperOfficeGuard\Middleware;

use OCA\Files_Sharing\Controller\ShareAPIController;
use OCA\HyperOfficeGuard\Service\Gateway;
use OCA\HyperOfficeGuard\Service\GuardUnavailable;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Http\Response;
use OCP\AppFramework\Middleware;

final class ShareMutationMiddleware extends Middleware {
    private ?string $hold = null;
    public function __construct(private Gateway $gateway) {}

    public function beforeController($controller, $methodName) {
        if (!$controller instanceof ShareAPIController || !in_array($methodName, ['deleteShare', 'updateShare'], true)) return;
        $this->hold = bin2hex(random_bytes(16));
        $this->gateway->notify('pause', $this->hold);
    }

    private function release(): void {
        if ($this->hold === null) return;
        $hold = $this->hold;
        $this->hold = null;
        $this->gateway->notify('revalidate', $hold);
    }

    public function afterController($controller, $methodName, Response $response) {
        try {
            $this->release();
            return $response;
        } catch (GuardUnavailable) {
            return new JSONResponse(['message' => 'The share changed, but Office isolation could not be confirmed. Check its actual state.'], 503);
        }
    }

    public function afterException($controller, $methodName, \Exception $exception) {
        try {
            $this->release();
        } catch (GuardUnavailable) {
            return new JSONResponse(['message' => 'Office isolation could not be confirmed. Check the actual share state.'], 503);
        }
        if ($exception instanceof GuardUnavailable) {
            return new JSONResponse(['message' => $exception->getMessage()], 503);
        }
        throw $exception;
    }
}
