export function notImplemented(name: string): Error {
  return new Error(`not implemented: ${name}`);
}
