# Send feedback or report a bug

Tell the people who run Reliquary about a bug, an idea or a question, from the web app or through your agent, and see what they did with it.

Feedback goes to the operator of the Reliquary you use: on Reliquary's hosted service that is Red Mage; on a [self-hosted](self-host.md) instance it is whoever runs that instance, and never Red Mage.

## From the web app

1. Choose **Feedback** in the top bar, on any page (on a narrow screen, the speech-bubble button next to the inbox). On a phone, open the account menu and choose **Send feedback**: the Feedback page opens with the page you were on.
2. Pick what it is: **Bug**, **Idea**, **Question** or **Other**.
3. Write what happened, or what would help. For a bug: what you did, what you expected, what happened, and the reference (`ref`) an error showed. See [Errors and reference IDs](../reference/errors.md).
4. Leave **Include this page** ticked to send the address of the page you're on (and, in a vault, which vault). Untick it to send the message alone.
5. Choose **Send**.

You land on the **Feedback** page with "Sent", and the message is listed under **What you've sent**. The full page, at **Feedback**, **Your feedback**, has the same form with an optional vault to pick.

## Through your agent

Any connected agent can send feedback for you, in the conversation you're already having, with the `send_feedback` tool. Ask it, for example:

> Send Reliquary feedback: search doesn't find words inside code blocks.

> Report a Reliquary bug: list_files failed with ref 1a2b3c4d when I renamed a folder.

The agent summarises in its own words and adds what it was doing, such as the tool and the error's reference. It sends it as you, and the feedback says which agent sent it. Any connection can send feedback, a read-only one included, since it writes nothing to a vault. To see the status and replies, ask it to "list my Reliquary feedback" (`list_my_feedback`).

Over MCP your agent sees what agents sent, the status and the operator's replies, but never the text of what you typed in the web app. See [MCP tools](../reference/mcp-tools.md).

## What happens next

Each item has a status the operator sets:

| Status | Means |
|---|---|
| **New** | Sent; not read yet |
| **Seen** | The operator has read it |
| **Planned** | The operator plans to act on it |
| **Fixed** | Fixed or done |
| **Won't fix** | The operator decided not to act on it |

The operator may also reply. The status and reply show on your **Feedback** page, under **What you've sent**, and to your agent. Only you and your agents see your feedback, and only the operator can change its status or reply.

## Good to know

- **Never include secrets, tokens or variable values.** Feedback is read by people and emailed to the operator. Describe the problem; don't paste a value.
- A message is up to 5000 characters. For a long log, summarise it and give the reference instead.
- You can send 20 an hour, from the web app and your agents together. Past that, the refusal says when you can send again. See [Limits](../reference/limits.md#feedback).
- Feedback is kept when a vault it names is deleted; it just no longer names the vault.
- Deleting your account deletes your feedback too. See [Delete your account](delete-your-account.md).
