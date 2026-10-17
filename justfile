set shell := ["bash", "-euo", "pipefail", "-c"]

# Show the available project commands.
default:
    @just --list

# Install the exact JavaScript dependency set.
setup:
    npm ci

# Start the isolated integration cases on loopback.
dev port="4197":
    npm run dev:integration -- --port {{ port }}

# Build the reusable package.
build:
    npm run build

# Run TypeScript checks and unit tests.
test:
    npm run check
    npm test

# Run optional static embed browser acceptance when needed.
test-browser:
    npm run build:embed
    npm run check:embed

# Validate types, unit tests, dependencies and distributable builds.
validate:
    npm run check
    npm test
    npm run check:spatial-package
    npm run build:embed
    npm run build:examples
    npm run build:integration
    @echo "Validation passed"

# Serve explicitly built integration cases locally.
serve port="8000":
    npm run build:integration
    npm exec --workspace @found-in-space/geant-integration -- vite preview --host 127.0.0.1 --port {{ port }}

# Remove local environments, caches, test output, and compiled artifacts.
clean:
    rm -rf node_modules dist test-results playwright-report
