// Secrets live in the macOS Keychain only (service "PersonalCommentary") — never in SQLite, files, logs, or UI responses.
import { Entry } from "@napi-rs/keyring";
import { APP_ID } from "./config.ts";

export type SecretName = "openai_api_key";

const memo = new Map<SecretName, string | null>();

export function getSecret(name: SecretName): string | null {
  if (process.env.COMMENTARY_TEST === "1" || process.env.COMMENTARY_SECRETS_FROM_ENV === "1") return process.env[`COMMENTARY_${name.toUpperCase()}`] ?? null;
  if (memo.has(name)) return memo.get(name)!;
  let v: string | null = null;
  try {
    v = new Entry(APP_ID, name).getPassword() ?? null;
  } catch {
    v = null;
  }
  memo.set(name, v);
  return v;
}

export function setSecret(name: SecretName, value: string | null) {
  memo.delete(name);
  if (process.env.COMMENTARY_TEST === "1" || process.env.COMMENTARY_SECRETS_FROM_ENV === "1") {
    if (value) process.env[`COMMENTARY_${name.toUpperCase()}`] = value;
    else delete process.env[`COMMENTARY_${name.toUpperCase()}`];
    return;
  }
  const e = new Entry(APP_ID, name);
  if (value) e.setPassword(value);
  else {
    try {
      e.deletePassword();
    } catch {
      /* already gone */
    }
  }
}

export function hasSecret(name: SecretName): boolean {
  return !!getSecret(name);
}
