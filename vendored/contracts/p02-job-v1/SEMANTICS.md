# P02 job v1 — semantics

Schema: `contracts/schemas/p02-job.v1.schema.json`. Vectors:
`contracts/fixtures/p02-job-v1/vectors.json`, checked by
`tools/quality/p02-job-v1.test.ts`. Owner and only consumer:
`libre-ai/personal-knowledge-workspace` (P02, information watch), which vendors
this schema byte-exact at a pinned commit of this authority.

## Scope

P02 runs two deployables over one PostgreSQL database: an API (Bun) that never
fetches a URL nor evaluates a rule, and a worker (Rust) that does both. A
`command` is what the API enqueues for the worker; a `result` is what the worker
records when a job ends. Nothing else crosses that boundary. The queue mechanics
(leases, attempts, dispatch) are storage, not contract.

v1 carries one operation, `fetch-source`. A new operation is a new accepted
payload: it follows `contracts/COMPATIBILITY.md` (coordinated change, all
consumers qualify first) or a new major.

## Trust

- Every string is untrusted data. A URL, a validator or a content type never
  becomes an instruction to an agent, a rule or a preference (P02 guarantee G7).
- The schema bounds shape only. The worker still applies its destination
  policy (public unicast only, one DNS resolution per hop, re-validated
  redirects) to `operation.url`, on the host as parsed and normalised by a
  WHATWG URL parser, never on the raw string: `http://0x7f000001/` passes the
  schema and is refused by the policy. A URL the schema accepts is not a URL
  the worker may reach.
- `url` and `finalUrl` accept only `http`/`https`, an authority without
  userinfo, `\`, `[`/`]` outside an IPv6 literal, and with no port other than
  an explicit 80 or 443; no whitespace or control character; at most 2048
  characters. `finalUrl` carries no fragment.
- Header values are printable ASCII, 1 to 1024 characters, with no leading or
  trailing space, so a validator cannot inject a header line.
- No body, title, content or credential is carried. A result records the size
  and BLAKE3 digest of the decoded body only.

## Commands

- `jobId` is unique per job. `tenantId` is the organization the job runs for;
  the worker reads the command under that tenant's row-level security context
  only.
- `idempotencyKey` is unique per tenant: enqueuing the same key twice yields one
  job (P02 guarantee G10).
- `validators` are the `ETag` / `Last-Modified` values of the previous fetch of
  the same URL, sent only on the first hop.

## Results

- `succeeded`: the HTTP exchange completed. `outcome` records the final hop:
  - `notModified` is true exactly when `httpStatus` is 304, and a 304 has no
    `body`;
  - a followed redirect status (301, 302, 303, 307, 308) is never a final hop
    (the worker refuses with `fetch.redirect_limit` or `fetch.redirect_invalid`
    instead); 300 and 305 are final statuses; 1xx never are;
  - a final 4xx or 5xx (404, 410, 429…) is a recorded outcome for source
    health, with no `body`; `body` (decoded size and BLAKE3 digest) appears
    only on a 2xx whose body was read.
  `reasonCode` is absent.
- `refused`: the policy refused the job; `reasonCode` is one of
  `fetch.url_invalid`, `fetch.scheme_forbidden`, `fetch.credentials_forbidden`,
  `fetch.port_forbidden`, `fetch.destination_forbidden`,
  `fetch.redirect_invalid`, `fetch.redirect_limit`, `fetch.redirect_downgrade`,
  `fetch.body_too_large`, `fetch.encoding_unsupported`,
  `fetch.validator_invalid`, `job.command_invalid`. A refused job is not retried.
- `failed`: the attempt did not complete, and retries are exhausted;
  `reasonCode` is one of `fetch.dns_no_address`, `fetch.dns_failed`,
  `fetch.connect_failed`, `fetch.connect_timeout`, `fetch.tls_failed`,
  `fetch.total_timeout`, `fetch.http_protocol`, `fetch.decoding_failed`,
  `fetch.unavailable`, `job.lease_expired`, `job.attempts_exhausted`,
  `job.store_unavailable`.
- Both refused and failed results carry a `reasonCode` and no `outcome`. The
  codes are closed enumerations, so a result cannot smuggle a host or an
  address through its reason.
