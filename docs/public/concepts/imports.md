# Imports

An import brings a whole `.env` file into a vault at once, and nothing is set until a person applies it in the web app.

## Two ways in

| | Paste | Push |
|---|---|---|
| How | Variables page, **Import .env**, paste the file, tick environments | `reliquary env push --file .env` from the CLI |
| Who | an owner or editor, in the web app | you, or an agent running the CLI for you |
| Waits as | a draft, only yours, for 30 minutes | a pending import, for 24 hours |
| Applied by | you, from its preview | an owner or editor, from the Variables page's notice or the Inbox |

Either way the values are encrypted on arrival and held on the server. The preview names each variable, says whether it is new or replaces a value (and which version), and lists the lines that weren't taken and why. It never shows a value. **Apply** sets them all, each logged; **Discard** or **Reject** drops them.

## Why a push needs a person

A push is how an agent can move a `.env` into a vault without the values passing through the conversation: the CLI reads the file and sends it straight to Reliquary. But anything an agent can run, injected text can try to run, so a push can only ever wait for approval. Only a person applies it, in the web app. The review page says an agent may have sent it.

A CLI sign-in can push only if you ticked **Also let it send .env files here** when you signed it in. Editors can't push to owners-only environments like `production`; the CLI says so before sending anything.

Agents see waiting pushes (names, environments, who and when, never values) through `list_variables`. No MCP tool sends, applies or rejects one.

## What the parser accepts

The web app and the CLI share one parser:

- `NAME=value` lines; `export ` before a name is ignored; spaces around `=` are ignored.
- Blank lines and lines starting with `#` are skipped. In an unquoted value, ` #` starts a comment.
- `"double quotes"` understand `\n`, `\r`, `\t`, `\"`, `\\` and `\$`, and may span lines. `'single quotes'` and backticks are taken literally and may span lines.
- No `${VAR}` expansion: values are taken as written.
- A name given twice uses the later line and says so.

Lines it refuses, each with its line number and a reason (never any of the value): no `=`, a bad name, a name that changes how programs start, an empty value, a NUL character, a value over 64 KiB, or text after a closing quote. A quote that never closes stops the parse there. A file over 512 KiB or 5000 lines is refused whole, and at most 200 variables are taken.

## Limits

At most 200 names and 4 MiB an import, 20 waiting per person per vault, and 60 an hour per person. See [Limits](../reference/limits.md).
