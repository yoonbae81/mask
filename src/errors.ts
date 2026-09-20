export class MaskError extends Error {
  statusCode = 500;
  constructor(message: string) {
    super(message);
    this.name = "MaskError";
  }
}

export class GuardTripped extends MaskError {
  override statusCode = 502;
  categories: Record<string, number> = {};
  constructor(message = "Guard tripped: sensitive terms detected in outbound request") {
    super(message);
    this.name = "GuardTripped";
  }
}

export class ConfigurationError extends MaskError {
  override statusCode = 500;
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class UpstreamError extends MaskError {
  override statusCode = 502;
  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = "UpstreamError";
    this.statusCode = statusCode;
  }
}
