/**
 * General Pura API exception.
 */
export class PuraApiException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PuraApiException';
    Object.setPrototypeOf(this, PuraApiException.prototype);
  }
}

/**
 * Exception to indicate there is an issue authenticating.
 */
export class PuraAuthenticationError extends PuraApiException {
  constructor(message: string) {
    super(message);
    this.name = 'PuraAuthenticationError';
    Object.setPrototypeOf(this, PuraAuthenticationError.prototype);
  }
}
