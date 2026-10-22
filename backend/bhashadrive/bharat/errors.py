"""Errors the BharatConnect pipeline reports to the UI: which stage failed, why, and whether a retry can help."""
from __future__ import annotations


class ServiceError(RuntimeError):
    def __init__(self, stage: str, message: str, status: int = 502, retryable: bool = True):
        super().__init__(message)
        self.stage, self.message, self.status, self.retryable = stage, message, status, retryable

    def detail(self) -> dict:
        return {"stage": self.stage, "message": self.message, "retryable": self.retryable}


_SETUP = ("Set GOOGLE_APPLICATION_CREDENTIALS to a service-account key file (or run "
          "`gcloud auth application-default login`), and GOOGLE_CLOUD_PROJECT to the project id.")


def google_error(stage: str, service: str, exc: Exception) -> ServiceError:
    """A Google client exception as a ServiceError a driver can act on."""
    from google.api_core import exceptions as gx
    from google.auth.exceptions import DefaultCredentialsError

    if isinstance(exc, DefaultCredentialsError):
        return ServiceError(stage, f"{service} is not set up: no Google Cloud credentials. {_SETUP}", 503, False)
    if isinstance(exc, (gx.Unauthenticated, gx.PermissionDenied)):
        return ServiceError(stage, f"{service} refused the credentials (is the API enabled for the project, and "
                                   f"does the account have access?): {exc.message}", 503, False)
    if isinstance(exc, gx.ResourceExhausted):
        return ServiceError(stage, f"{service} quota or rate limit reached. Wait a moment and retry.", 429)
    if isinstance(exc, (gx.DeadlineExceeded, gx.ServiceUnavailable)):
        return ServiceError(stage, f"{service} did not answer in time (network?). Retry.", 504)
    if isinstance(exc, gx.InvalidArgument):
        return ServiceError(stage, f"{service} rejected the request: {exc.message}", 400, False)
    if isinstance(exc, gx.GoogleAPICallError):
        return ServiceError(stage, f"{service} error: {exc.message}", 502)
    return ServiceError(stage, f"{service} failed: {exc}", 502)
