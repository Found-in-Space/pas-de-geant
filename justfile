set shell := ["bash", "-euo", "pipefail", "-c"]

# Show the available project commands.
default:
    @just --list

# Install the exact JavaScript dependency set.
setup:
    npm ci

# Start the Vite development server.
dev port="5173":
    npm run dev -- --port {{ port }}

# Build the production application.
build:
    npm run build

# Run TypeScript checks and package/integration tests.
test:
    npm run check
    npm test

# Run the production application browser suite.
test-browser:
    npm run build
    npm run test:browser

# Validate types, unit tests, browser behavior, and the production build.
validate:
    npm run check
    npm test
    npm run build
    npm run test:browser
    @echo "Validation passed"

# Serve the built production application locally.
serve port="8000":
    npm run build
    npm run preview --workspace @found-in-space/pas-de-geant -- --port {{ port }}

# Remove local environments, caches, test output, and compiled artifacts.
clean:
    rm -rf node_modules dist test-results playwright-report packages/shadowline/dist packages/shadowline-astronomy-engine/dist
