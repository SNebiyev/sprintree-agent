# Security policy

## Reporting a vulnerability

Please report privately through GitHub Security Advisories: open the **Security** tab of this repository and
choose **Report a vulnerability**. Do not open a public issue for a vulnerability. Never paste a real token
into a report.

## Supported versions

The latest 0.x release. Fixes land there, there are no backports.

## Scope and handling of secrets

- `skills/sprintree/scripts/st.mjs` reads its token only from `SPRINTREE_TOKEN` and never prints it.
  Redaction decodes percent escapes and `\u` escapes (depth 5, like gitleaks) but not base64 or hex; the configured token is always hidden.
- The skill treats card text as untrusted data (see the README, "Auth").
- Never commit a token or put one in `.sprintree.json`. A leaked token: revoke it in Sprintree under
  Settings -> API & MCP -> Personal access tokens.
