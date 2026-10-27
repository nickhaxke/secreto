import { passwordHash } from "../netlify/functions/lib/security.js";
// Read from stdin so the plaintext password is never a shell argument.
let input = "";
for await (const chunk of process.stdin) input += chunk;
const password = input.replace(/\r?\n$/, "");
if (password.length < 14 || password.length > 256)
  throw new Error("Use an organizer password between 14 and 256 characters.");
console.log(await passwordHash(password));
