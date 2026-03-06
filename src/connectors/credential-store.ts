import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface CredentialStore {
  readonly kind: string;
  isAvailable(): Promise<boolean>;
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<boolean>;
}

export class MemoryCredentialStore implements CredentialStore {
  readonly kind = "memory";

  private readonly values = new Map<string, string>();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async get(ref: string): Promise<string | undefined> {
    return this.values.get(ref);
  }

  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }

  async delete(ref: string): Promise<boolean> {
    return this.values.delete(ref);
  }
}

interface FileCredentialMap {
  values: Record<string, string>;
}

export class FileCredentialStore implements CredentialStore {
  readonly kind = "file";

  private readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private async load(): Promise<FileCredentialMap> {
    if (!existsSync(this.path)) {
      return { values: {} };
    }

    const contents = await readFile(this.path, "utf8");
    const parsed = JSON.parse(contents) as unknown;

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("values" in parsed) ||
      typeof (parsed as { values?: unknown }).values !== "object" ||
      (parsed as { values?: unknown }).values === null
    ) {
      return { values: {} };
    }

    return {
      values: { ...((parsed as { values: Record<string, string> }).values ?? {}) }
    };
  }

  private async save(map: FileCredentialMap): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  }

  async get(ref: string): Promise<string | undefined> {
    const map = await this.load();
    const value = map.values[ref];
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  async set(ref: string, value: string): Promise<void> {
    const map = await this.load();
    map.values[ref] = value;
    await this.save(map);
  }

  async delete(ref: string): Promise<boolean> {
    const map = await this.load();
    if (!(ref in map.values)) {
      return false;
    }
    delete map.values[ref];
    await this.save(map);
    return true;
  }
}

const KEYCHAIN_SERVICE_NAME = "multi-agent-framework";

export class MacOSKeychainCredentialStore implements CredentialStore {
  readonly kind = "keychain";

  async isAvailable(): Promise<boolean> {
    return process.platform === "darwin";
  }

  private run(args: string[]): { success: boolean; stdout: string } {
    const result = spawnSync("security", args, {
      encoding: "utf8"
    });

    return {
      success: result.status === 0,
      stdout: result.stdout ?? ""
    };
  }

  async get(ref: string): Promise<string | undefined> {
    const result = this.run([
      "find-generic-password",
      "-a",
      ref,
      "-s",
      KEYCHAIN_SERVICE_NAME,
      "-w"
    ]);

    const value = result.stdout.trim();
    return result.success && value ? value : undefined;
  }

  async set(ref: string, value: string): Promise<void> {
    const result = this.run([
      "add-generic-password",
      "-U",
      "-a",
      ref,
      "-s",
      KEYCHAIN_SERVICE_NAME,
      "-w",
      value
    ]);

    if (!result.success) {
      throw new Error(`Unable to store credential "${ref}" in the OS keychain.`);
    }
  }

  async delete(ref: string): Promise<boolean> {
    const result = this.run([
      "delete-generic-password",
      "-a",
      ref,
      "-s",
      KEYCHAIN_SERVICE_NAME
    ]);

    return result.success;
  }
}

export function createCredentialStore(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): CredentialStore {
  switch (env.MAF_CREDENTIAL_STORE_BACKEND) {
    case "file":
      return new FileCredentialStore(env.MAF_CREDENTIAL_STORE_FILE ?? "./.multi-agent-framework/credentials.json");
    case "memory":
      return new MemoryCredentialStore();
    default:
      return new MacOSKeychainCredentialStore();
  }
}
