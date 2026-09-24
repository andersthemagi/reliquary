// The marker half of people.ts, with no dependencies, so html.ts can use it.
// See people.ts.

import { randomBytes } from "node:crypto";

const NONCE = randomBytes(12).toString("hex");
export const PERSON_MARK = new RegExp(`\\[\\[person:${NONCE}:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\]\\]`, "g");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A person, for a page: their email if the reader may see it, else the
// first 8 characters of their id. Safe inside text and attribute values
// (esc() leaves it as it is).
export const personRef = (id: string): string => (UUID.test(id) ? `[[person:${NONCE}:${id}]]` : id.slice(0, 8));

export const shortId = (id: string): string => id.slice(0, 8);
