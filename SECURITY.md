# Security Policy

## Supported branches

Security fixes target the default branch (`main`) unless the repository documents an explicit release branch.

## Reporting a vulnerability

Please do not open public issues for suspected vulnerabilities or exposed secrets.

Use GitHub private vulnerability reporting when available, or contact the repository owner privately with:

- affected repository and commit;
- impact summary;
- reproduction steps;
- whether any secret, token, personal data, or production credential may be involved.

## Baseline expectations

- No secrets or personal data in fixtures, logs, issues, or commits.
- CI must stay deterministic and must not require secrets for the default checks.
- Dependency and workflow changes require review.
