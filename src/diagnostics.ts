/** Preserve receive order across asynchronous protocol-to-editor conversion. */
export class DiagnosticGate {
  private sequence = new Map<string, object>();
  async publish<T>(uri: string, valid: () => boolean, convert: () => Promise<T>,
                   apply: (value: T) => void): Promise<void> {
    const sequence = {};
    this.sequence.set(uri, sequence);
    if (!valid()) return;
    const value = await convert();
    if (valid() && this.sequence.get(uri) === sequence) apply(value);
  }
  forget(uri: string): void {this.sequence.delete(uri);}
  clear(): void {this.sequence.clear();}
}
