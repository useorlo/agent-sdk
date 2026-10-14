# Publishing the TypeScript SDK

The `Publish npm SDK` workflow builds and tests the exact version in `packages/typescript/package.json`, publishes with provenance, and checks installation from npm. It runs manually on `main`; it does not publish on pull requests or ordinary pushes. TypeScript and Python releases are independent.

## First npm release

1. Add a short-lived npm granular token as the repository Actions secret `NPM_TOKEN`. Allow package read/write (publish and stage) for the `@orlo` scope and enable bypass 2FA for automated publication. Organization-management permissions are not needed. Never commit the token or paste it in an issue.
2. Run `publish-npm.yml` on `main`, specifying the package version and `bootstrap-token` authentication.
3. Check the workflow's registry-install verification and the npm package page. If publication succeeds but verification fails, verify the existing version before retrying; npm does not permit replacing a published version.

## Later releases

After the first package exists, configure its npm trusted publisher with GitHub organization `useorlo`, repository `agent-sdk`, workflow filename `publish-npm.yml`, environment `npm`, and direct publishing permission. Choose `trusted` authentication for subsequent runs. Revoke the bootstrap token and remove the `NPM_TOKEN` secret after the transition.

Update the package version and lockfile together, document changes, and run the compatibility workflow before publishing. The npm job does not publish Python packages. Keep private platform dependencies pinned and verify protocol compatibility when updating them.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [granular tokens](https://docs.npmjs.com/creating-and-viewing-access-tokens/).
