/**
 * Utilities.
 */

export const ENCODING = 'utf-8';
export const ISSUE_URL = 'https://github.com/natekspencer/pypura/issues/1';

/**
 * Decode a base64 encoded value.
 */
export function decode(value: string): string {
  return Buffer.from(value, 'base64').toString(ENCODING);
}
