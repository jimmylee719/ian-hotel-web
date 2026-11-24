const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const LIMIT = 256 - (256 % ALPHABET.length); // reject bytes above this to avoid modulo bias

/** `NK-` + 6 characters without look-alikes (0/O, 1/I/L). */
export function newReservationCode(): string {
  let out = "";
  while (out.length < 6) {
    for (const b of crypto.getRandomValues(new Uint8Array(8))) {
      if (b < LIMIT && out.length < 6) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return `NK-${out}`;
}
