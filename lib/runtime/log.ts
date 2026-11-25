import { redactValue } from "./redact";

/**
 * The app's logger: console.log / warn / error with every argument passed through redact first (strings, Error
 * messages and stacks, plain objects), so a card number, an Authorization header or a key=value secret in an
 * adapter's or job's message never reaches Workers logs. Same methods, same arguments, otherwise unchanged.
 */
export const log = {
  info: (...args: unknown[]): void => console.log(...args.map(redactValue)),
  warn: (...args: unknown[]): void => console.warn(...args.map(redactValue)),
  error: (...args: unknown[]): void => console.error(...args.map(redactValue)),
};
