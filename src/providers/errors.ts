export type ProviderBootstrapErrorCode =
  | "UNSUPPORTED_PROVIDER_MODE"
  | "PROVIDER_NOT_IMPLEMENTED"
  | "PROVIDER_CREDENTIALS_MISSING"
  | "PROVIDER_UNSUPPORTED_ID";

export type ProviderRuntimeErrorCode =
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_RESPONSE_MALFORMED"
  | "PROVIDER_REQUEST_FAILED";

export type ProviderErrorCode = ProviderBootstrapErrorCode | ProviderRuntimeErrorCode;

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly cause?: unknown;

  constructor(code: ProviderErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.cause = cause;
  }
}

export class ProviderBootstrapError extends ProviderError {
  readonly code: ProviderBootstrapErrorCode;

  constructor(code: ProviderBootstrapErrorCode, message: string) {
    super(code, message);
    this.name = "ProviderBootstrapError";
    this.code = code;
  }
}

export class UnsupportedProviderModeError extends ProviderBootstrapError {
  constructor(mode: string) {
    super(
      "UNSUPPORTED_PROVIDER_MODE",
      `UNSUPPORTED_PROVIDER_MODE: Provider mode "${mode}" is not supported. Expected one of: mock, live, auto.`
    );
    this.name = "UnsupportedProviderModeError";
  }
}

export class ProviderNotImplementedError extends ProviderBootstrapError {
  constructor(providerId: string) {
    super(
      "PROVIDER_NOT_IMPLEMENTED",
      `PROVIDER_NOT_IMPLEMENTED: Provider "${providerId}" is not implemented for live execution in this phase.`
    );
    this.name = "ProviderNotImplementedError";
  }
}

export class ProviderCredentialsMissingError extends ProviderBootstrapError {
  readonly missingEnv: string[];

  constructor(providerId: string, missingEnv: string[]) {
    super(
      "PROVIDER_CREDENTIALS_MISSING",
      `PROVIDER_CREDENTIALS_MISSING: Provider "${providerId}" requires credential environment variable(s): ${missingEnv.join(
        ", "
      )}.`
    );
    this.name = "ProviderCredentialsMissingError";
    this.missingEnv = [...missingEnv];
  }
}

export class ProviderUnsupportedIdError extends ProviderBootstrapError {
  constructor(providerId: string) {
    super(
      "PROVIDER_UNSUPPORTED_ID",
      `PROVIDER_UNSUPPORTED_ID: Provider "${providerId}" is not supported in live or auto mode.`
    );
    this.name = "ProviderUnsupportedIdError";
  }
}

export class ProviderRuntimeError extends ProviderError {
  readonly code: ProviderRuntimeErrorCode;
  readonly providerId: string;

  constructor(
    code: ProviderRuntimeErrorCode,
    providerId: string,
    message: string,
    cause?: unknown
  ) {
    super(code, message, cause);
    this.name = "ProviderRuntimeError";
    this.code = code;
    this.providerId = providerId;
  }
}

export class ProviderAuthFailedError extends ProviderRuntimeError {
  readonly status?: number;

  constructor(providerId: string, status?: number, cause?: unknown) {
    super(
      "PROVIDER_AUTH_FAILED",
      providerId,
      `PROVIDER_AUTH_FAILED: Provider "${providerId}" rejected authentication${
        status ? ` (status ${status})` : ""
      }.`,
      cause
    );
    this.name = "ProviderAuthFailedError";
    this.status = status;
  }
}

export class ProviderRateLimitedError extends ProviderRuntimeError {
  readonly retryAfter?: string;

  constructor(providerId: string, retryAfter?: string, cause?: unknown) {
    super(
      "PROVIDER_RATE_LIMITED",
      providerId,
      `PROVIDER_RATE_LIMITED: Provider "${providerId}" returned rate limiting${
        retryAfter ? ` (retry-after: ${retryAfter})` : ""
      }.`,
      cause
    );
    this.name = "ProviderRateLimitedError";
    this.retryAfter = retryAfter;
  }
}

export class ProviderTimeoutError extends ProviderRuntimeError {
  readonly timeoutMs?: number;

  constructor(providerId: string, timeoutMs?: number, cause?: unknown) {
    super(
      "PROVIDER_TIMEOUT",
      providerId,
      `PROVIDER_TIMEOUT: Provider "${providerId}" timed out${
        timeoutMs ? ` after ${timeoutMs}ms` : ""
      }.`,
      cause
    );
    this.name = "ProviderTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class ProviderResponseMalformedError extends ProviderRuntimeError {
  constructor(providerId: string, details: string, cause?: unknown) {
    super(
      "PROVIDER_RESPONSE_MALFORMED",
      providerId,
      `PROVIDER_RESPONSE_MALFORMED: Provider "${providerId}" returned malformed response. ${details}`,
      cause
    );
    this.name = "ProviderResponseMalformedError";
  }
}

export class ProviderRequestFailedError extends ProviderRuntimeError {
  constructor(providerId: string, details: string, cause?: unknown) {
    super(
      "PROVIDER_REQUEST_FAILED",
      providerId,
      `PROVIDER_REQUEST_FAILED: Provider "${providerId}" request failed. ${details}`,
      cause
    );
    this.name = "ProviderRequestFailedError";
  }
}
