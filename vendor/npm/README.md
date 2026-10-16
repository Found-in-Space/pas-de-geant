# Local spatial alpha

The `spatial-0.3.0-alpha.0-<sha256-prefix>.tgz` archive is the dependency-free
coordinate package built from `skykit/packages/spatial`. Regenerate it with
`npm run spatial:refresh`. The script packs the source and updates both the
worlds and app dependencies and npm lockfile; it never publishes to npm.

The distinct alpha version keeps the installed SkyKit 0.2.0 runtime on its own
compatible spatial 0.2.0 dependency. Replacing its dependency with the new API
would break that released runtime. Keep the archive and generated lockfile
together. When the compatible SkyKit/spatial release batch is published,
replace these local file dependencies with exact registry versions.
