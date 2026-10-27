import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const opaque = () => randomBytes(32).toString("base64url");
export const fingerprint = (value, secret) =>
  createHmac("sha256", secret).update(value).digest("hex");
export async function passwordHash(value) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(value, salt, 64);
  return `scrypt:${salt}:${derived.toString("hex")}`;
}
export async function passwordMatches(value, encoded) {
  if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded || "")) return false;
  const [, salt, key] = encoded.split(":");
  const actual = await scrypt(value, salt, 64);
  return timingSafeEqual(actual, Buffer.from(key, "hex"));
}
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (status, message) => {
  throw new HttpError(status, message);
};
export function cleanName(value) {
  if (typeof value !== "string") fail(400, "Please enter a name.");
  const name = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!name || name.length > 80 || /[\p{Cc}\p{Cf}<>]/u.test(name))
    fail(400, "Names must contain 1 to 80 printable characters.");
  return name;
}
export const normalized = (name) => name.toLocaleLowerCase("en-US");
export function participantNames(input) {
  const values =
    typeof input === "string"
      ? input.split(/[\n,;]+/).filter((x) => x.trim())
      : input;
  if (!Array.isArray(values) || !values.length || values.length > 100)
    fail(400, "Add between 1 and 100 names.");
  const names = values.map(cleanName);
  if (new Set(names.map(normalized)).size !== names.length)
    fail(409, "Each participant needs a unique name.");
  return names;
}
export function eventInput(input) {
  const name = cleanName(input.name);
  const date = input.exchange_date;
  if (
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date ||
    date < new Date().toISOString().slice(0, 10)
  )
    fail(400, "Choose a valid exchange date today or later.");
  if (
    !Number.isSafeInteger(input.budget) ||
    input.budget < 0 ||
    input.budget > 100000000
  )
    fail(400, "Enter a valid budget.");
  if (!["USD", "EUR", "GBP", "KES"].includes(input.currency))
    fail(400, "Choose a supported currency.");
  return {
    name,
    exchange_date: date,
    budget: input.budget,
    currency: input.currency,
  };
}
