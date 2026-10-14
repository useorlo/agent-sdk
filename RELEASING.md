# Publishing the TypeScript SDK

The `Publish npm SDK` workflow builds and tests the exact version in `packages/typescript/package.json`, publishes with provenance, and checks installation from npm. It runs manually on `main`; it does not publish on pull requests or ordinary pushes. TypeScript and Python releases are independent.

Version `0.0.2` and the Python 0.1.1 source archive were released on 14 October 2026. The [publication and verification workflow](https://github.com/useorlo/agent-sdk/actions/runs/38602847140) passed. Both downloaded archive attestations were verified with `gh attestation verify --repo useorlo/agent-sdk`. Trusted publishing configuration remains the next release setup step.

## First npm release

1. Add a short-lived npm granular token as the repository Actions secret `NPM_TOKEN`. Allow package read/write (publish and stage) for the `@orlo` scope and enable bypass 2FA for automated publication. Organization-management permissions are not needed. Never commit the token or paste it in an issue.
2. Run `publish-npm.yml` on `main`, specifying the package version and `bootstrap-token` authentication.
3. Check the workflow's registry-install verification and the npm package page. npm scans new publications before making them installable. Verification retries for about 15 minutes, with a 20-minute limit including network time. If publication succeeds but verification fails, rerun with `verify_only: true` to check the existing version without publishing again. npm does not permit replacing a published version.

## Later releases

After the first package exists, configure its npm trusted publisher with GitHub organization `useorlo`, repository `agent-sdk`, workflow filename `publish-npm.yml`, environment `npm`, and direct publishing permission. Choose `trusted` authentication for subsequent runs. Revoke the bootstrap token and remove the `NPM_TOKEN` secret after the transition.

Update the package version and lockfile together, document changes, and run the compatibility workflow before publishing. The npm job does not publish Python packages. Keep private platform dependencies pinned and verify protocol compatibility when updating them.

See [npm publication scanning](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/), [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [granular tokens](https://docs.npmjs.com/creating-and-viewing-access-tokens/).

## Public archives for console downloads

After npm installation verification passes, the workflow packages the Python source from the same public commit, installs and tests that archive, and creates a GitHub release with both archives and SHA-256 checksums. GitHub attestations bind the archives to this public workflow. The TypeScript archive is fetched from npm unchanged. Python is not published to PyPI by this job. Action dependencies are pinned to commit SHAs.

If the archive job fails after npm publication, rerun only that failed job; do not republish npm. Console builds must pin the verified archive URLs and hashes and copy their bytes unchanged. They must not generate a different archive under the same release version.
