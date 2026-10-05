/** A received manifest diagnostic set belongs to the observed disk contents. */
export class ManifestDiagnostics<T> {
  private disk?: string;
  private cached?: {disk: string, value: T};
  private waiting = true;
  observe(disk: string | undefined): void {
    if (disk === undefined || disk !== this.disk) {
      this.cached = undefined;
      this.waiting = true;
    }
    this.disk = disk;
  }
  publish(disk: string | undefined, value: T): void {
    this.observe(disk);
    if (disk !== undefined) {
      this.cached = {disk, value};
      this.waiting = false;
    }
  }
  visible(dirty: boolean): T | undefined {
    return dirty || this.waiting ? undefined : this.cached?.value;
  }
  clear(): void {this.observe(undefined);}
}
