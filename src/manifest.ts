/** Constant-space evidence collected while a raw notification establishes its first hash. */
export class ManifestBaseline {
  private observed = false;
  private disk?: string;
  private invalid = false;
  observe(disk: string | undefined): void {
    if (disk === undefined || (this.observed && disk !== this.disk)) this.invalid = true;
    this.observed = true;
    this.disk = disk;
  }
  accepts(disk: string): boolean {
    return !this.invalid && (!this.observed || this.disk === disk);
  }
}

/** A received manifest diagnostic set belongs to the observed disk contents. */
export class ManifestDiagnostics<T> {
  private disk?: string;
  private observed = false;
  private generation = 0;
  get revision(): number {return this.generation;}
  matches(disk: string | undefined): boolean {return disk !== undefined && disk === this.disk;}
  private cached?: {disk: string, value: T};
  private waiting = true;
  observe(disk: string | undefined): void {
    if (disk === undefined || (this.observed && disk !== this.disk)) ++this.generation;
    this.observed = true;
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
