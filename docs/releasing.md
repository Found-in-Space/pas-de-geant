# Releasing Shadowline

Shadowline uses Changesets to version and publish its two public packages.
The core package must be available before publishing the Astronomy Engine
adapter at the same version.

1. Start from a clean `main` checkout with Node.js 22 or later.
2. Run `npm ci` and `just validate`.
3. Run `npm run release:check-packed-consumers`.
4. Add and review changesets during development with `npm run changeset`.
5. Apply the pending versions and refresh the lockfile with
   `npm run release:version`.
6. Commit the generated package and changelog updates.
7. Authenticate to npm with an account allowed to publish
   `@found-in-space/*`.
8. Run `npm run release:publish`, then push the commit and generated tags.

Before the first publish, verify that the package names are available and that
the npm organisation has public scoped-package publishing enabled. If release
automation is added, use npm Trusted Publishing with GitHub Actions OIDC and
package-level repository metadata; never store an npm token in this repository.
