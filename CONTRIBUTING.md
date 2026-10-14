# Contributing

Thanks for contributing to the Orlo Agent SDKs.

## Contribution model

This project uses the **Developer Certificate of Origin (DCO)** instead of a CLA.

By submitting a contribution, you certify that you have the right to submit it under the terms of the DCO.

## Sign-off requirement

Every commit must include a `Signed-off-by` trailer matching the commit author identity.

Example:

```text
Signed-off-by: Jane Doe <jane@example.com>
```

Git can add this automatically:

```bash
git commit -s
```

## Pull request expectations

- keep changes focused
- include tests when behavior changes
- update package docs when public APIs change
- keep the SDKs independent of private platform packages

## Boundary rule

SDK packages must not depend on:

- the private API app
- worker internals
- database migrations or platform persistence
- private organization or policy infrastructure
