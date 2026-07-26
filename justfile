set shell := ["bash", "-euo", "pipefail", "-c"]

# Show the available project commands.
default:
    @just --list

# Install the exact JavaScript dependency set.
setup:
    npm ci

# Start the Vite development server.
dev port="5173":
    npm run dev --workspace @found-in-space/shadowline-visualizer -- --port {{ port }}

# Build the packages and production SPA.
build:
    npm run build

# Run TypeScript checks and package/integration tests.
test:
    npm run check
    npm test

# Run the production SPA browser suite with OpenStreetMap requests stubbed.
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
    npm run preview --workspace @found-in-space/shadowline-visualizer -- --port {{ port }}

# Remove local environments, caches, test output, and compiled artifacts.
clean:
    rm -rf node_modules dist test-results playwright-report packages/shadowline/dist packages/shadowline-astronomy-engine/dist
