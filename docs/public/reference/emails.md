# Emails

Every email Reliquary sends about your account, what it's for, and how to tell a real one.

All of them look the same: the Reliquary name, one short message, and a line at the bottom naming the site that sent it and the account it's about. None has images, tracking or attachments.

## How to tell a real one

- Its links go only to the site you use Reliquary on, for example `https://app.reliquary.redmage.cc/auth/confirm?...`. Nothing asks you to sign in anywhere else.
- A sign-in code is 6 digits. Reliquary never asks for it by email, chat or phone: you only type it into the sign-in page yourself.
- Reliquary has no passwords. An email asking for one isn't from Reliquary.

If you get one you didn't ask for, ignore it. Nothing changes unless someone uses the code or link in it.

## Signing in

| Subject | When | What's in it |
|---|---|---|
| Your Reliquary sign-in code | You ask to sign in | A 6-digit code, and a **Sign in** button for the device you read it on. Both work once, within 10 minutes. |
| Confirm your email for Reliquary | You sign in for the first time, from an invite | The same code and button; using either confirms the address and makes your account. |
| You have a Reliquary account | Whoever runs the site made an account for you | A **Sign in** button that works once. After that, sign in with your address and a code. |
| Reliquary has no password to reset | Someone asked to reset your password | Why there's nothing to reset, and a **Sign in** button that works once. |
| Your Reliquary confirmation code | Someone signed in to your account asked to change how it signs in | A 6-digit code to confirm that change. |

A **Sign in** button opens a page with one more **Sign in** button, so a mail scanner that opens links can't use yours up.

## Changing your email address

| Subject | When |
|---|---|
| Confirm the new email address for your Reliquary account | Someone asked to change your account's address. The email names the old and new address and has a **Confirm the change** button. When one went to each address, confirm both: the change happens once both are confirmed. |

## Security notices

Sent after a change to your account, to tell you it happened. If it was you, there's nothing to do. If it wasn't, tell the person who runs your Reliquary site right away.

| Subject |
|---|
| The email address of your Reliquary account was changed |
| The password of your Reliquary account was changed |
| The phone number of your Reliquary account was changed |
| A sign-in method was added to your Reliquary account |
| A sign-in method was removed from your Reliquary account |
| A second sign-in step was added to your Reliquary account |
| A second sign-in step was removed from your Reliquary account |

## Vault invites

| Subject | When | What's in it |
|---|---|---|
| You're invited to *vault name* on Reliquary | A vault owner invited your address | The vault, your role, the address it's for, when it expires, and a button with the invite link, also written out. The link works once, only for someone signed in with that address. |

Invites are emailed when the site has an email sender (the hosted service does). Otherwise, or if the email couldn't be sent, the owner copies the link from the **Members** page and sends it to you another way: it's the same link. See [Members and invites](../concepts/members.md).

## On a self-hosted instance

The same emails, sent through your own SMTP server. Nothing to set up: the web app hands them to the sign-in service. Vault invites are the exception: the web app sends them itself, through Resend, only if you set `RESEND_API_KEY` and `EMAIL_FROM`. See [Self-host Reliquary](../how-to/self-host.md#email-for-invites).
