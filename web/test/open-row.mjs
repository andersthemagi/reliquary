// For tests that read a content row straight from the database: the row's
// body opened under the key the servers seal with (CONTENT_KEYS, web/test.sh).
const content = await import("../dist/content.js");
content.configureContent({ CONTENT_KEYS: process.env.CONTENT_KEYS ?? "" });
export const openBody = (body, vaultId) => (body === null ? null : content.openBody(body, vaultId));
export const isSealed = (body) => body !== null && content.isSealed(body);
